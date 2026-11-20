import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { appointmentFixture, type AppointmentFixture, type AppointmentTenant } from "./helpers/passpilotAppointmentFixture.js";

process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";
process.env.RLS_GUC_ENABLED = "true";

// The normal DB lane supplies a migrated local synthetic database. A checkout
// without a fixture can run the isolated unit suite without touching any DB.
describe("PassPilot indicator database authorization and occupancy", { skip: !process.env.DATABASE_URL }, () => {
  let f: AppointmentFixture;
  let legacy: AppointmentTenant;
  let canonical: AppointmentTenant;
  let otherSchool: AppointmentTenant;
  before(async () => {
    f = await appointmentFixture();
    legacy = await f.createTenant();
    canonical = await f.createTenant(true);
    otherSchool = await f.createTenant();
  });
  after(async () => { if (f) await f.close(); });

  function requestPairing(tenant: AppointmentTenant, target: { classId: string } | { kioskSessionId: string }, actor = tenant.teacher) {
    return fetch(f.url + "/passpilot/indicators/pairings", {
      method: "POST", headers: { "content-type": "application/json", ...f.headers(tenant, actor) },
      body: JSON.stringify({ ...target, waterCustomDestination: "Water" }),
    });
  }

  async function pair(tenant: AppointmentTenant, target: { classId: string } | { kioskSessionId: string } = { classId: tenant.classId }) {
    const response = await requestPairing(tenant, target);
    assert.equal(response.status, 201, await response.clone().text());
    return await response.json() as { pairingId: string; token: string; expiresAt: string };
  }

  async function state(token: string) {
    return fetch(f.url + "/passpilot/indicators/state", { headers: { authorization: `Bearer ${token}` } });
  }

  async function seed(tenant: AppointmentTenant, index: number, patch: { teacherId?: string; classId?: string; destination?: string; custom?: string; status?: string; kioskSessionId?: string } = {}) {
    const id = randomUUID();
    await f.sql(`INSERT INTO passes(id,school_id,student_id,teacher_id,grade_id,classpilot_group_id,destination,custom_destination,status,issued_at,expires_at,issued_via,issuing_kiosk_session_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()-interval '1 day',now()-interval '23 hours',$10,$11)`, [
      id, tenant.schoolId, tenant.students[index]!, patch.teacherId ?? tenant.teacher.id,
      tenant.canonical ? null : patch.classId ?? tenant.classId,
      tenant.canonical ? patch.classId ?? tenant.classId : null,
      patch.destination ?? "bathroom", patch.custom ?? null, patch.status ?? "active",
      patch.kioskSessionId ? "kiosk" : "teacher", patch.kioskSessionId ?? null,
    ]);
    return id;
  }

  it("follows one owned kiosk across classes and resumed sessions while keeping outstanding passes occupied", async () => {
    const tenant = await f.createTenant();
    const { hashPassword } = await import("../src/util/password.js");
    await f.sql("UPDATE schools SET kiosk_enabled=true,kiosk_pin_hash=$2 WHERE id=ANY($1::text[])", [[tenant.schoolId, otherSchool.schoolId], await hashPassword("4721")]);
    const { claimKioskSessionByCode, createKioskSession, createResumedKioskSession, createSelfClaimedKioskSession, updateKioskSessionClass } = await import("../src/services/storage.js");
    const scoped = <T>(fn: () => Promise<T>) => f.runWithTenantContext({ schoolId: tenant.schoolId }, fn);
    const auth = { actorUserId: tenant.teacher.id, manager: false };
    const device = randomUUID();
    const waiting = await scoped(() => createKioskSession(tenant.schoolId, device));
    const first = await scoped(() => claimKioskSessionByCode(tenant.schoolId, waiting.claimCode, null, auth));
    const unattached = await scoped(() => createSelfClaimedKioskSession(tenant.schoolId, null, auth));
    const outsiderWaiting = await scoped(() => createKioskSession(tenant.schoolId, randomUUID()));
    await scoped(() => claimKioskSessionByCode(tenant.schoolId, outsiderWaiting.claimCode, null, { actorUserId: tenant.outsider.id, manager: false }));
    const list = await fetch(f.url + "/passpilot/indicators/pairings/kiosks", { headers: f.headers(tenant, tenant.teacher) });
    assert.equal(list.status, 200, await list.clone().text());
    assert.equal(list.headers.get("cache-control"), "no-store");
    assert.deepEqual(await list.json(), { kiosks: [{ kioskSessionId: first.id, className: null, lastSeenAt: first.lastSeenAt.toISOString() }] });
    assert.equal((await requestPairing(tenant, { kioskSessionId: first.id }, tenant.outsider)).status, 403);
    assert.equal((await requestPairing(otherSchool, { kioskSessionId: first.id })).status, 403);
    assert.equal((await requestPairing(tenant, { kioskSessionId: randomUUID() })).status, 403);
    assert.equal((await requestPairing(tenant, { kioskSessionId: unattached.id })).status, 403);

    const credential = await pair(tenant, { kioskSessionId: first.id });
    assert.deepEqual(Object.keys(credential).sort(), ["expiresAt", "pairingId", "token"]);
    const expectMask = async (mask: number) => {
      const response = await state(credential.token);
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(await response.json(), { version: 1, mask, maxAgeSeconds: 30 });
    };
    await expectMask(0);

    const currentClass = await scoped(() => updateKioskSessionClass(tenant.schoolId, first.id, { source: "legacy_grades", classId: tenant.classId }, auth));
    assert.equal(currentClass?.gradeId, tenant.classId);
    const checkout = await fetch(f.url + "/passpilot/kiosk/checkout", {
      method: "POST", headers: { "content-type": "application/json", "x-school-id": tenant.schoolId,
        "x-kiosk-pin": "4721", "x-kiosk-session": first.id, "x-kiosk-device": device },
      body: JSON.stringify({ studentId: tenant.students[0], destination: "bathroom" }),
    });
    assert.equal(checkout.status, 201, await checkout.clone().text());
    const { pass: { id: outstanding } } = await checkout.json() as { pass: { id: string } };
    await f.sql("UPDATE passes SET expires_at=now()-interval '1 minute' WHERE id=$1", [outstanding]);
    const secondWaiting = await scoped(() => createKioskSession(tenant.schoolId, randomUUID()));
    const second = await scoped(() => claimKioskSessionByCode(tenant.schoolId, secondWaiting.claimCode, null, auth));
    await seed(tenant, 1, { kioskSessionId: second.id, destination: "office" });
    const outside = await seed(tenant, 2, { kioskSessionId: first.id, teacherId: tenant.outsider.id, destination: "nurse" });
    await seed(tenant, 3, { destination: "office" });
    const otherScoped = <T>(fn: () => Promise<T>) => f.runWithTenantContext({ schoolId: otherSchool.schoolId }, fn);
    const foreignWaiting = await otherScoped(() => createKioskSession(otherSchool.schoolId, device));
    const foreign = await otherScoped(() => claimKioskSessionByCode(otherSchool.schoolId, foreignWaiting.claimCode, null, { actorUserId: otherSchool.teacher.id, manager: false }));
    await seed(otherSchool, 8, { kioskSessionId: foreign.id, destination: "nurse" });
    await expectMask(1);

    const nextClass = randomUUID();
    await f.sql("INSERT INTO grades(id,school_id,name) VALUES($1,$2,'Next class')", [nextClass, tenant.schoolId]);
    await f.sql("INSERT INTO teacher_grades(teacher_id,grade_id) VALUES($1,$2)", [tenant.teacher.id, nextClass]);
    const next = await scoped(() => updateKioskSessionClass(tenant.schoolId, first.id, { source: "legacy_grades", classId: nextClass }, auth));
    assert.equal(next?.gradeId, nextClass);
    await expectMask(1);

    await f.sql("UPDATE passpilot_kiosk_sessions SET last_seen_at=now()-interval '21 hours' WHERE id=$1", [first.id]);
    assert.equal((await state(credential.token)).status, 403);
    await scoped(() => createKioskSession(tenant.schoolId));
    const issuer = await f.sql("SELECT status, released_at FROM passpilot_kiosk_sessions WHERE school_id=$1 AND id=$2", [tenant.schoolId, first.id]);
    assert.equal(issuer.rows[0]?.status, "released");
    assert.ok(issuer.rows[0]?.released_at);
    await f.sql("UPDATE passpilot_kiosk_sessions SET released_at=now()-interval '2 days' WHERE id=$1", [first.id]);
    const resumed = await scoped(() => createResumedKioskSession(tenant.schoolId, device));
    assert.notEqual(resumed.id, first.id);
    await expectMask(1);

    const water = await seed(tenant, 4, { kioskSessionId: resumed.id, classId: nextClass, destination: "custom", custom: "Water" });
    const checkin = await fetch(f.url + `/passpilot/passes/${outstanding}/return`, { method: "PATCH", headers: f.headers(tenant, tenant.teacher) });
    assert.equal(checkin.status, 200, await checkin.clone().text());
    await expectMask(1);
    await f.sql("UPDATE passes SET status='returned' WHERE id=$1", [water]);
    await expectMask(0);

    await f.sql("UPDATE passes SET status='canceled' WHERE id=$1", [outside]);
    await scoped(() => createKioskSession(tenant.schoolId));
    assert.equal((await f.sql("SELECT 1 FROM passpilot_kiosk_sessions WHERE school_id=$1 AND id=$2", [tenant.schoolId, first.id])).rowCount, 0);
    await f.sql("UPDATE schools SET kiosk_enabled=false WHERE id=$1", [tenant.schoolId]);
    assert.equal((await state(credential.token)).status, 403);
  });

  it("keeps the kiosk paired until its last live same-device session is released", async () => {
    const tenant = await f.createTenant();
    await f.sql("UPDATE schools SET kiosk_enabled=true WHERE id=$1", [tenant.schoolId]);
    const { claimKioskSessionByCode, createKioskSession, releaseKioskSession } = await import("../src/services/storage.js");
    const scoped = <T>(fn: () => Promise<T>) => f.runWithTenantContext({ schoolId: tenant.schoolId }, fn);
    const device = randomUUID();
    const auth = { actorUserId: tenant.teacher.id, manager: false };
    async function claim() {
      const waiting = await scoped(() => createKioskSession(tenant.schoolId, device));
      return scoped(() => claimKioskSessionByCode(tenant.schoolId, waiting.claimCode, null, auth));
    }
    const first = await claim();
    const second = await claim();
    const list = await fetch(f.url + "/passpilot/indicators/pairings/kiosks", { headers: f.headers(tenant, tenant.teacher) });
    assert.equal(list.status, 200, await list.clone().text());
    const { kiosks } = await list.json() as { kiosks: Array<{ kioskSessionId: string; className: string | null; lastSeenAt: string }> };
    assert.deepEqual(kiosks.sort((left, right) => left.kioskSessionId.localeCompare(right.kioskSessionId)),
      [first, second].map(session => ({ kioskSessionId: session.id, className: null, lastSeenAt: session.lastSeenAt.toISOString() }))
        .sort((left, right) => left.kioskSessionId.localeCompare(right.kioskSessionId)));
    const credential = await pair(tenant, { kioskSessionId: second.id });
    await scoped(() => releaseKioskSession(tenant.schoolId, second.id, auth));
    assert.deepEqual(await (await state(credential.token)).json(), { version: 1, mask: 0, maxAgeSeconds: 30 });
    await scoped(() => releaseKioskSession(tenant.schoolId, first.id, auth));
    assert.equal((await state(credential.token)).status, 403);
  });

  it("rejects the old kiosk credential after the device is claimed away and back", async () => {
    const tenant = await f.createTenant(true);
    await f.sql("UPDATE schools SET kiosk_enabled=true WHERE id=$1", [tenant.schoolId]);
    const { claimKioskSessionByCode, createKioskSession, releaseKioskSession } = await import("../src/services/storage.js");
    const scoped = <T>(fn: () => Promise<T>) => f.runWithTenantContext({ schoolId: tenant.schoolId }, fn);
    const device = randomUUID();
    async function claim(actorUserId: string) {
      const waiting = await scoped(() => createKioskSession(tenant.schoolId, device));
      return scoped(() => claimKioskSessionByCode(tenant.schoolId, waiting.claimCode, null, { actorUserId, manager: false }));
    }
    const original = await claim(tenant.teacher.id);
    const old = await pair(tenant, { kioskSessionId: original.id });
    const other = await claim(tenant.outsider.id);
    assert.equal((await state(old.token)).status, 403);
    await scoped(() => releaseKioskSession(tenant.schoolId, other.id, { actorUserId: tenant.outsider.id, manager: false }));
    const recovered = await claim(tenant.teacher.id);
    assert.equal((await state(old.token)).status, 403);
    const replacement = await pair(tenant, { kioskSessionId: recovered.id });
    assert.deepEqual(await (await state(replacement.token)).json(), { version: 1, mask: 0, maxAgeSeconds: 30 });
  });

  it("isolates both class sources, author, school, lifecycle and exact water while keeping overdue occupied", async () => {
    for (const tenant of [legacy, canonical]) {
      const credential = await pair(tenant);
      assert.deepEqual(await (await state(credential.token)).json(), { version: 1, mask: 0, maxAgeSeconds: 30 });
      const wrongClass = randomUUID();
      if (tenant.canonical) {
        await f.sql("BEGIN");
        try {
          await f.sql("INSERT INTO groups(id,school_id,teacher_id,name,group_type,status) VALUES($1,$2,$3,'Other indicator class','admin_class','active')", [wrongClass, tenant.schoolId, tenant.teacher.id]);
          await f.sql("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'primary')", [wrongClass, tenant.teacher.id]);
          await f.sql("COMMIT");
        } catch (error) { await f.sql("ROLLBACK"); throw error; }
      } else await f.sql("INSERT INTO grades(id,school_id,name) VALUES($1,$2,'Other indicator class')", [wrongClass, tenant.schoolId]);
      const overdue = await seed(tenant, 0);
      await seed(tenant, 1, { teacherId: tenant.outsider.id, destination: "nurse" });
      await seed(tenant, 2, { classId: wrongClass, destination: "office" });
      await seed(tenant, 3, { status: "returned", destination: "nurse" });
      await f.sql("UPDATE students SET status='inactive' WHERE id=$1", [tenant.students[4]!]);
      await seed(tenant, 4, { destination: "office" });
      const foreignPass = await seed(otherSchool, 0, { destination: "nurse" });
      assert.deepEqual(await (await state(credential.token)).json(), { version: 1, mask: 1, maxAgeSeconds: 30 });
      await f.sql("UPDATE passes SET status='returned' WHERE id=ANY($1::varchar[])", [[overdue, foreignPass]]);
      const water = await seed(tenant, 5, { destination: "custom", custom: "Water fountain" });
      assert.deepEqual(await (await state(credential.token)).json(), { version: 1, mask: 0, maxAgeSeconds: 30 });
      await f.sql("UPDATE passes SET custom_destination='Water' WHERE id=$1", [water]);
      assert.deepEqual(await (await state(credential.token)).json(), { version: 1, mask: 1, maxAgeSeconds: 30 });
      await seed(tenant, 6, { destination: "office" });
      assert.deepEqual(await (await state(credential.token)).json(), { version: 1, mask: 3, maxAgeSeconds: 30 });
      await seed(tenant, 7, { destination: "nurse" });
      assert.deepEqual(await (await state(credential.token)).json(), { version: 1, mask: 7, maxAgeSeconds: 30 });
      await f.sql("UPDATE product_licenses SET status='suspended' WHERE school_id=$1 AND product='PASSPILOT'", [tenant.schoolId]);
      assert.equal((await state(credential.token)).status, 403);
      await f.sql("UPDATE product_licenses SET status='active' WHERE school_id=$1 AND product='PASSPILOT'", [tenant.schoolId]);
      await f.sql("UPDATE schools SET disabled_at=now() WHERE id=$1", [tenant.schoolId]);
      assert.equal((await state(credential.token)).status, 403);
      await f.sql("UPDATE schools SET disabled_at=NULL WHERE id=$1", [tenant.schoolId]);
      await f.sql("UPDATE settings SET passpilot_class_source=$2 WHERE school_id=$1", [tenant.schoolId, tenant.canonical ? "legacy_grades" : "classpilot_groups"]);
      assert.equal((await state(credential.token)).status, 403);
      await f.sql("UPDATE settings SET passpilot_class_source=$2 WHERE school_id=$1", [tenant.schoolId, tenant.canonical ? "classpilot_groups" : "legacy_grades"]);
      const deniedRevoke = await fetch(f.url + `/passpilot/indicators/pairings/${credential.pairingId}`, { method: "DELETE", headers: f.headers(tenant, tenant.outsider) });
      assert.equal(deniedRevoke.status, 404);
      const foreignRevoke = await fetch(f.url + `/passpilot/indicators/pairings/${credential.pairingId}`, { method: "DELETE", headers: f.headers(otherSchool, otherSchool.teacher) });
      assert.equal(foreignRevoke.status, 404);
      assert.equal((await fetch(f.url + `/passpilot/indicators/pairings/${credential.pairingId}`, { method: "DELETE", headers: f.headers(tenant, tenant.teacher) })).status, 204);
      assert.equal((await state(credential.token)).status, 401);
    }
  });
});
