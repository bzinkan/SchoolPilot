import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ROSTER_INTEGRATIONS_SQL } from "../src/db/rosterIntegrationsMigration.js";
import type { RosterPackage } from "../src/services/rosterIntegrationModel.js";

process.env.REDIS_URL="";
const schoolId=randomUUID(), otherSchoolId=randomUUID(), adminId=randomUUID();
let pool:import("pg").Pool;
let database:typeof import("../src/db.js").default;
let tenant:typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
let store:typeof import("../src/services/rosterIntegrationStore.js");
let connectionId:string;
const scoped=<T>(fn:()=>Promise<T>)=>tenant({schoolId},fn);
const snapshot:RosterPackage={provider:"oneroster",version:"1.1",complete:true,warnings:[],organizations:[{id:"org",name:"Roster test",type:"school"}],people:[{id:"teacher",firstName:"Admin",lastName:"Teacher",email:`${adminId}@test.example.edu`,studentNumber:null,grade:null,schoolIds:["org"],roles:["teacher"]},{id:"student",firstName:"Imported",lastName:"Student",email:`${schoolId}@test.example.edu`,studentNumber:"roster-1",grade:"5",schoolIds:["org"],roles:["student"]}],classes:[{id:"class",name:"Imported Math",schoolId:"org",grade:"5",term:"Fall",primaryTeacherId:"teacher",coTeacherIds:[],studentIds:["student"]}]};

before(async()=>{
  assert.ok(["localhost","127.0.0.1","::1"].includes(new URL(process.env.DATABASE_URL||"").hostname),"Roster integration tests require a local fixture database.");
  const module=await import("../src/db.js");pool=module.pool;database=module.default;
  ({runWithTenantContext:tenant}=await import("../src/middleware/tenantContext.js"));
  store=await import("../src/services/rosterIntegrationStore.js");
  await pool.query(ROSTER_INTEGRATIONS_SQL);
  await pool.query("INSERT INTO schools(id,name,domain) VALUES($1,'Roster integration test','test.example.edu'),($2,'Other roster test','test.example.edu')",[schoolId,otherSchoolId]);
  await pool.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Admin','Teacher')",[adminId,`${adminId}@test.example.edu`]);
  await pool.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'admin','active')",[schoolId,adminId]);
  await pool.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')",[schoolId]);
  connectionId=(await scoped(()=>store.saveRosterConnection({schoolId,userId:adminId,provider:"oneroster",providerIdentity:"test-source",name:"Test source"}))).id;
});

after(async()=>{
  if(!pool)return;
  await tenant({isSuper:true},async()=>{
    const {sql}=await import("drizzle-orm");
    for(const table of ["roster_integration_memberships","roster_integration_identities","roster_integration_runs","roster_integration_connections","import_runs","audit_logs"]){await database.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE school_id=${schoolId}`);}
    await database.execute(sql`DELETE FROM group_students WHERE group_id IN(SELECT id FROM groups WHERE school_id=${schoolId})`);
    await database.execute(sql`DELETE FROM group_teachers WHERE group_id IN(SELECT id FROM groups WHERE school_id=${schoolId})`);
    await database.execute(sql`DELETE FROM groups WHERE school_id=${schoolId}`);
    await database.execute(sql`DELETE FROM students WHERE school_id=${schoolId}`);
  });
  await pool.query("DELETE FROM product_licenses WHERE school_id=$1",[schoolId]);
  await pool.query("DELETE FROM school_memberships WHERE school_id=$1",[schoolId]);
  await pool.query("DELETE FROM users WHERE id=$1",[adminId]);
  await pool.query("DELETE FROM schools WHERE id IN($1,$2)",[schoolId,otherSchoolId]);
  const {sessionPool}=await import("../src/db.js");await Promise.all([pool.end(),sessionPool.end()]);
});

describe("Roster reconciliation transactions",()=>{
  it("checkpoints resumably, keeps internal IDs and PINs, and clears staged personal data on completion",async()=>{
    const staged=await scoped(()=>store.stageRosterPackage(schoolId,connectionId,snapshot,adminId));
    const preview=await scoped(()=>store.previewRosterRun(schoolId,staged.id,{organizationIds:["org"]}));
    const partial=await scoped(()=>store.applyRosterRun(schoolId,staged.id,preview.planHash!,adminId,false,1));
    assert.equal(partial.cursor,1);assert.equal(partial.status,"applying");
    const completed=await scoped(()=>store.applyRosterRun(schoolId,staged.id,preview.planHash!,adminId));
    assert.equal(completed.status,"completed");assert.equal(completed.snapshot,null);assert.equal(completed.plan,null);
    const before=await scoped(()=>store.loadRosterCatalogue(schoolId,connectionId));assert.equal(before.students.length,1);assert.equal(before.classes.length,1);
    const {sql}=await import("drizzle-orm");await scoped(()=>database.execute(sql`UPDATE students SET classpilot_pin_hash='test-preserved-hash',classpilot_pin_encrypted='test-preserved-ciphertext' WHERE school_id=${schoolId}`));
    const next=await scoped(()=>store.stageRosterPackage(schoolId,connectionId,snapshot,adminId));const reviewed=await scoped(()=>store.previewRosterRun(schoolId,next.id,{organizationIds:["org"]}));
    await scoped(()=>store.applyRosterRun(schoolId,next.id,reviewed.planHash!,adminId));
    const after=await scoped(()=>store.loadRosterCatalogue(schoolId,connectionId));assert.deepEqual(after.students.map(row=>row.id),before.students.map(row=>row.id));assert.deepEqual(after.classes.map(row=>row.id),before.classes.map(row=>row.id));
    const retained=await scoped(()=>database.execute<{classpilot_pin_hash:string;classpilot_pin_encrypted:string}>(sql`SELECT classpilot_pin_hash,classpilot_pin_encrypted FROM students WHERE school_id=${schoolId}`));assert.equal(retained.rows[0]?.classpilot_pin_hash,"test-preserved-hash");assert.equal(retained.rows[0]?.classpilot_pin_encrypted,"test-preserved-ciphertext");
  });
  it("rejects stale preview writes and hides another school's integration",async()=>{
    const staged=await scoped(()=>store.stageRosterPackage(schoolId,connectionId,snapshot,adminId));const reviewed=await scoped(()=>store.previewRosterRun(schoolId,staged.id,{organizationIds:["org"]}));
    const {sql}=await import("drizzle-orm");await scoped(()=>database.execute(sql`UPDATE students SET first_name='Manual edit' WHERE school_id=${schoolId}`));
    await assert.rejects(scoped(()=>store.applyRosterRun(schoolId,staged.id,reviewed.planHash!,adminId)),{code:"ROSTER_PREVIEW_STALE"});
    await assert.rejects(tenant({schoolId:otherSchoolId},()=>store.getRosterRun(otherSchoolId,staged.id)),{code:"ROSTER_RUN_NOT_FOUND"});
  });
  it("preserves a manual ON CONFLICT enrollment when the next source snapshot removes it",async()=>{
    const local=await scoped(()=>store.loadRosterCatalogue(schoolId,connectionId));const group=local.classes[0]!,student=local.students[0]!;
    const {addGroupStudents}=await import("../src/services/storage.js");await scoped(()=>addGroupStudents(group.id,[student.id]));
    const removed={...snapshot,classes:snapshot.classes.map(row=>({...row,studentIds:[]}))};
    const staged=await scoped(()=>store.stageRosterPackage(schoolId,connectionId,removed,adminId));const reviewed=await scoped(()=>store.previewRosterRun(schoolId,staged.id,{organizationIds:["org"]}));
    await scoped(()=>store.applyRosterRun(schoolId,staged.id,reviewed.planHash!,adminId,true));
    const after=await scoped(()=>store.loadRosterCatalogue(schoolId,connectionId));assert(after.classes[0]?.students.some(row=>row.memberId===student.id));assert.equal(after.students[0]?.firstName,"Manual edit");
  });
  it("rejects fetched Clever snapshots and automatic previews after a connection revision changes",async()=>{
    const {sql}=await import("drizzle-orm");const fetchingId=randomUUID();const connection=await scoped(()=>store.getRosterConnection(schoolId,connectionId));
    await scoped(()=>database.execute(sql`INSERT INTO roster_integration_runs(id,school_id,connection_id,status,base_revision,expires_at) VALUES(${fetchingId},${schoolId},${connectionId},'fetching',${connection.revision},now()+interval '1 hour')`));
    try {
      await scoped(()=>database.execute(sql`UPDATE roster_integration_connections SET revision=revision+1 WHERE id=${connectionId}`));
      await assert.rejects(scoped(()=>store.finishCleverRosterFetch(schoolId,fetchingId,connection.revision,{...snapshot,provider:"clever"})),{code:"ROSTER_CONNECTION_CHANGED"});
      const run=await scoped(()=>store.getRosterRun(schoolId,fetchingId));assert.equal(run.snapshot,null);assert.equal(run.status,"fetching");
      const staged=await scoped(()=>store.stageRosterPackage(schoolId,connectionId,snapshot,adminId));
      await assert.rejects(scoped(()=>store.previewRosterRun(schoolId,staged.id,{organizationIds:["org"]},connection.revision)),{code:"ROSTER_CONNECTION_CHANGED"});
      assert.equal((await scoped(()=>store.getRosterRun(schoolId,staged.id))).plan,null);
    } finally {
      // This test invokes the fetch helper directly. Production's worker catches its error
      // and marks the run failed; remove this synthetic in-flight row before the next test.
      await scoped(()=>database.execute(sql`DELETE FROM roster_integration_runs WHERE school_id=${schoolId} AND id=${fetchingId}`));
    }
  });
  it("persists source archive provenance and restores a returning class with its reviewed status change",async()=>{
    const apply=async(source:RosterPackage)=>{const staged=await scoped(()=>store.stageRosterPackage(schoolId,connectionId,source,adminId));const preview=await scoped(()=>store.previewRosterRun(schoolId,staged.id,{organizationIds:["org"]}));await scoped(()=>store.applyRosterRun(schoolId,staged.id,preview.planHash!,adminId,true));return preview;};
    const withReturning={...snapshot,classes:[...snapshot.classes,{...snapshot.classes[0]!,id:"returning",name:"Returning Science",studentIds:[]}]};
    await apply(withReturning);
    const before=await scoped(()=>store.loadRosterCatalogue(schoolId,connectionId));const classId=before.identities.find(row=>row.entityType==="class"&&row.externalId==="returning")!.internalId;
    await apply(snapshot);
    const archived=await scoped(()=>store.loadRosterCatalogue(schoolId,connectionId));const source=archived.identities.find(row=>row.externalId==="returning")!;const group=archived.classes.find(row=>row.id===classId)!;
    assert.equal(group.status,"archived");assert.equal(source.sourcePresent,false);assert.equal(source.lastApplied.archivedAt,group.archivedAt);assert.equal(source.lastApplied.status,"archived");
    const preview=await apply(withReturning);const plan=preview.plan as import("../src/services/rosterIntegrationPlanner.js").RosterPlan;
    assert.deepEqual(plan.steps.find(row=>row.externalId==="returning")?.review?.fields.find(row=>row.field==="status"),{field:"status",before:"archived",after:"active"});
    const restored=(await scoped(()=>store.loadRosterCatalogue(schoolId,connectionId))).classes.find(row=>row.id===classId)!;
    assert.equal(restored.status,"active");assert.equal(restored.archivedAt,null);assert.equal(restored.scheduleEnabled,false);
  });
});
