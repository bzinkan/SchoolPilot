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

  async function pair(tenant: AppointmentTenant) {
    const response = await fetch(f.url + "/passpilot/indicators/pairings", {
      method: "POST", headers: { "content-type": "application/json", ...f.headers(tenant, tenant.teacher) },
      body: JSON.stringify({ classId: tenant.classId, waterCustomDestination: "Water" }),
    });
    assert.equal(response.status, 201, await response.clone().text());
    return await response.json() as { pairingId: string; token: string; expiresAt: string };
  }

  async function state(token: string) {
    return fetch(f.url + "/passpilot/indicators/state", { headers: { authorization: `Bearer ${token}` } });
  }

  async function seed(tenant: AppointmentTenant, index: number, patch: { teacherId?: string; classId?: string; destination?: string; custom?: string; status?: string } = {}) {
    const id = randomUUID();
    await f.sql(`INSERT INTO passes(id,school_id,student_id,teacher_id,grade_id,classpilot_group_id,destination,custom_destination,status,issued_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()-interval '1 day',now()-interval '23 hours')`, [
      id, tenant.schoolId, tenant.students[index]!, patch.teacherId ?? tenant.teacher.id,
      tenant.canonical ? null : patch.classId ?? tenant.classId,
      tenant.canonical ? patch.classId ?? tenant.classId : null,
      patch.destination ?? "bathroom", patch.custom ?? null, patch.status ?? "active",
    ]);
    return id;
  }

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
