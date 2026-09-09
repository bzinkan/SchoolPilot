import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import db, { pool, sessionPool } from "../src/db.js";
import { runWithTenantContext } from "../src/middleware/tenantContext.js";
import { CLASSPILOT_COVERAGE_CATEGORIES_SQL } from "../src/db/classpilotCoverageCategoriesMigration.js";
import { browseCoverageGroups, getCoverageGroupDetail, listCoverageCategories, mutateCoverageCategory, saveCoverageDirectoryGroup } from "../src/services/classpilotCoverageDirectory.js";
import { deleteCoverageSupervisionGroup } from "../src/services/classpilotCoverageDeletion.js";
import { lockStaffAssignmentLifecycleSchool } from "../src/services/staffAssignmentLifecycleLock.js";
import { sql } from "drizzle-orm";

const schoolIds: string[] = [], userIds: string[] = [];
const scoped = <T>(schoolId: string, operation: () => Promise<T>) => runWithTenantContext({ schoolId }, operation);
before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname));
  await pool.query(CLASSPILOT_COVERAGE_CATEGORIES_SQL);
});
after(async () => {
  try {
    for (const table of ["classpilot_coverage_scope_group_members", "classpilot_coverage_assignments", "classpilot_coverage_scope_groups", "classpilot_coverage_group_categories", "audit_logs", "students", "settings", "school_memberships", "product_licenses"]) await pool.query("DELETE FROM " + table + " WHERE school_id=ANY($1::text[])", [schoolIds]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::text[])", [userIds]);
    await pool.query("DELETE FROM schools WHERE id=ANY($1::text[])", [schoolIds]);
  } finally {
    const { schedulerPool, schedulerLockPool } = await import("../src/services/schedulerDb.js");
    await Promise.all([pool.end(), sessionPool.end(), schedulerPool.end(), schedulerLockPool.end()]);
  }
});
async function fixture() {
  const schoolId = randomUUID(), adminId = randomUUID(), staffId = randomUUID(), viewerId = randomUUID();
  schoolIds.push(schoolId); userIds.push(adminId, staffId, viewerId);
  await pool.query("INSERT INTO schools(id,name,status,is_active,plan_status) VALUES($1,'Directory fixture','active',true,'active')", [schoolId]);
  await pool.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [schoolId]);
  for (const [userId,role,last] of [[adminId,"admin","Administrator"],[staffId,"teacher","Proctor"],[viewerId,"teacher","Manager"]]) {
    await pool.query("INSERT INTO users(id,email,first_name,last_name,display_name) VALUES($1,$2,'Directory',$3,$4)", [userId,`${userId}@example.test`,last,`Directory ${last}`]);
    await pool.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,$3,'active')", [schoolId,userId,role]);
  }
  const studentIds: string[] = [];
  for (const grade of ["5","6",null]) {
    const studentId = randomUUID(); studentIds.push(studentId);
    await pool.query("INSERT INTO students(id,school_id,first_name,last_name,email,status,grade_level) VALUES($1,$2,'Private','Roster',$3,'active',$4)", [studentId,schoolId,`${studentId}@example.test`,grade]);
  }
  return { schoolId, adminId, staffId, viewerId, studentIds };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function addGroup(data: Fixture, name = "Testing room", overrides: Record<string, unknown> = {}) {
  return scoped(data.schoolId, () => saveCoverageDirectoryGroup({ schoolId: data.schoolId, actorId: data.adminId, body: { name, studentIds: [data.studentIds[0]], staffIds: [data.staffId], ...overrides } }));
}
async function category(data: Fixture, name = "Testing") {
  const result = await scoped(data.schoolId, () => mutateCoverageCategory({ schoolId: data.schoolId, actorId: data.adminId, body: { name } }));
  assert.ok("category" in result && result.category); return result.category;
}
const browse = (data: Fixture, query: Record<string,string> = {}, actorId = data.adminId) => scoped(data.schoolId, () => browseCoverageGroups({ schoolId: data.schoolId, actorId, query }));
const categoriesFor = (data: Fixture, actorId = data.adminId) => scoped(data.schoolId, () => listCoverageCategories({ schoolId: data.schoolId, actorId }));

test("directory returns stable pages, scoped facets and aggregate grades without roster payloads", async () => {
  const data = await fixture(), cat = await category(data);
  for (let index=0;index<28;index++) await addGroup(data, `Room ${String(index).padStart(2,"0")}`, { categoryId: index < 26 ? cat.id : null, studentIds: index===0 ? data.studentIds : [data.studentIds[0]] });
  const first = await browse(data), second = await browse(data,{ page:"2" });
  assert.equal(first.total,28); assert.equal(first.groups.length,25); assert.equal(second.groups.length,3); assert.equal(first.totalPages,2);
  assert.equal(new Set([...first.groups,...second.groups].map(row=>row.id)).size,28);
  assert.deepEqual((await browse(data)).groups.map(row=>row.id),first.groups.map(row=>row.id));
  assert.equal((await browse(data,{page:"999"})).page,2);
  assert.equal((await browse(data,{categoryId:cat.id})).total,26);
  assert.equal((await browse(data,{categoryId:"uncategorized"})).total,2);
  assert.equal((await browse(data,{grade:"6"})).total,1);
  assert.equal((await browse(data,{grade:"ungraded"})).total,1);
  assert.equal((await browse(data,{staffId:data.staffId})).total,28);
  assert.equal((await browse(data,{staffId:"unassigned"})).total,0);
  assert.equal((await browse(data,{search:"directory proctor"})).total,28);
  assert.equal((await browse(data,{search:"%"})).total,0);
  assert.equal(first.facets.staff.length,1); assert.equal(first.facets.categories.length,1);
  for (const privateValue of [...data.studentIds,"Private","Roster",'"students"',"deviceId"]) assert.equal(JSON.stringify(first).includes(privateValue),false);
  assert.equal(first.groups[0]!.studentCount,3);
  assert.deepEqual(first.groups[0]!.gradeCounts,[{gradeLevel:"5",count:1},{gradeLevel:"6",count:1},{gradeLevel:null,count:1}]);
  const earlier=await addGroup(data,"Alphabetically first inactive");
  await scoped(data.schoolId,()=>saveCoverageDirectoryGroup({schoolId:data.schoolId,actorId:data.adminId,groupId:earlier.group.id,body:{active:false}}));
  assert.equal((await browse(data)).groups[0]!.id,earlier.group.id);
  assert.equal((await browse(data,{active:"true"})).total,28);
});

test("scope authorization precedes grade/search/count/facets and detail never exposes a partially authorized group", async () => {
  const data = await fixture(), foreign = await fixture();
  const cat = await category(data,"Visible"), hiddenCat=await category(data,"Hidden");
  const allowed=await addGroup(data,"Allowed",{categoryId:cat.id}), mixed=await addGroup(data,"Hidden mixed",{studentIds:data.studentIds.slice(0,2),categoryId:hiddenCat.id});
  await addGroup(data,"Empty admin",{studentIds:[],staffIds:[]});
  await pool.query("INSERT INTO classpilot_coverage_assignments(school_id,staff_id,scope_type,scope_value,permissions,created_by) VALUES($1,$2,'grade','5','{\"setup\":true}', $3)",[data.schoolId,data.viewerId,data.adminId]);
  const own=await scoped(data.schoolId,()=>saveCoverageDirectoryGroup({schoolId:data.schoolId,actorId:data.viewerId,body:{name:"Own empty",studentIds:[],staffIds:[]}}));
  const result=await browse(data,{},data.viewerId);
  assert.deepEqual(new Set(result.groups.map(row=>row.id)),new Set([allowed.group.id,own.group.id]));
  assert.equal((await browse(data,{grade:"5",search:"Hidden"},data.viewerId)).total,0);
  assert.deepEqual(result.facets.categories,[{id:cat.id,name:cat.name}]);
  assert.equal((await categoriesFor(data,data.viewerId)).categories.find(row=>row.id===hiddenCat.id)?.groupCount,0);
  await assert.rejects(scoped(data.schoolId,()=>getCoverageGroupDetail({schoolId:data.schoolId,actorId:data.viewerId,groupId:mixed.group.id})),{code:"NOT_FOUND"});
  const foreignGroup=await addGroup(foreign);
  await assert.rejects(scoped(data.schoolId,()=>getCoverageGroupDetail({schoolId:data.schoolId,actorId:data.adminId,groupId:foreignGroup.group.id})),{code:"NOT_FOUND"});
  const detail=await scoped(data.schoolId,()=>getCoverageGroupDetail({schoolId:data.schoolId,actorId:data.viewerId,groupId:allowed.group.id}));
  assert.ok("students" in detail.group); assert.equal(detail.group.students.length,1);
  const summary=await scoped(data.schoolId,()=>getCoverageGroupDetail({schoolId:data.schoolId,actorId:data.viewerId,groupId:allowed.group.id,summaryOnly:true}));
  assert.equal("students" in summary.group,false);
  const emptied=await scoped(data.schoolId,()=>saveCoverageDirectoryGroup({schoolId:data.schoolId,actorId:data.viewerId,groupId:allowed.group.id,body:{studentIds:[],updatedAt:allowed.group.updatedAt}}));
  assert.equal(emptied.group.studentCount,0);
  assert.deepEqual((await browse(data,{},data.viewerId)).groups.map(row=>row.id),[own.group.id]);
});

test("staff facets require active claim/observe pairing and memberships; inactive roster counts are explicit", async()=>{
  const data=await fixture(); const group=await addGroup(data);
  await pool.query("INSERT INTO classpilot_coverage_assignments(school_id,staff_id,scope_type,scope_value,permissions,created_by) VALUES($1,$2,'coverage_group',$3,'{\"observe\":true}',$4),($1,$5,'coverage_group',$3,'{\"setup\":true}',$4)",[data.schoolId,data.staffId,group.group.id,data.adminId,data.viewerId]);
  await pool.query("UPDATE students SET status='inactive' WHERE id=$1",[data.studentIds[0]]);
  const first=await browse(data); assert.equal(first.groups[0]!.staff.length,1); assert.equal(first.groups[0]!.studentCount,0); assert.equal(first.groups[0]!.inactiveStudentCount,1);
  await pool.query("UPDATE classpilot_coverage_assignments SET active=false WHERE school_id=$1 AND staff_id=$2",[data.schoolId,data.staffId]);
  await pool.query("UPDATE school_memberships SET status='inactive' WHERE school_id=$1 AND user_id=$2",[data.schoolId,data.staffId]);
  const second=await browse(data,{staffId:"unassigned"}); assert.equal(second.total,1); assert.deepEqual(second.facets.staff,[]);
});

test("inactive coverage scopes cannot authorize a new group or disclose another group's roster",async()=>{
  const data=await fixture(), scope=await addGroup(data,"Scope"), target=await addGroup(data,"Target");
  await pool.query("INSERT INTO classpilot_coverage_assignments(school_id,staff_id,scope_type,scope_value,permissions,created_by) VALUES($1,$2,'coverage_group',$3,'{\"setup\":true}',$4)",[data.schoolId,data.viewerId,scope.group.id,data.adminId]);
  assert.equal((await browse(data,{},data.viewerId)).total,2);
  await scoped(data.schoolId,()=>saveCoverageDirectoryGroup({schoolId:data.schoolId,actorId:data.adminId,groupId:scope.group.id,body:{active:false}}));
  assert.equal((await browse(data,{},data.viewerId)).total,0);
  await assert.rejects(scoped(data.schoolId,()=>getCoverageGroupDetail({schoolId:data.schoolId,actorId:data.viewerId,groupId:target.group.id})),{code:"NOT_FOUND"});
  await assert.rejects(scoped(data.schoolId,()=>saveCoverageDirectoryGroup({schoolId:data.schoolId,actorId:data.viewerId,body:{name:"Out of scope",studentIds:[data.studentIds[0]],staffIds:[]}})),{code:"FORBIDDEN"});
});

test("category lifecycle is admin-only, same-school and versioned, and removal uncategorizes without deleting setup",async()=>{
  const data=await fixture(), foreign=await fixture(), cat=await category(data), other=await category(foreign);
  await pool.query("INSERT INTO classpilot_coverage_assignments(school_id,staff_id,scope_type,permissions,created_by) VALUES($1,$2,'setup','{\"setup\":true}',$3)",[data.schoolId,data.viewerId,data.adminId]);
  await assert.rejects(scoped(data.schoolId,()=>mutateCoverageCategory({schoolId:data.schoolId,actorId:data.viewerId,body:{name:"Forbidden"}})),{code:"FORBIDDEN"});
  await assert.rejects(category(data," testing "),{code:"COVERAGE_CATEGORY_DUPLICATE"});
  await assert.rejects(addGroup(data,"Foreign category",{categoryId:other.id}),{code:"COVERAGE_CATEGORY_STALE"});
  const added=await scoped(data.schoolId,()=>saveCoverageDirectoryGroup({schoolId:data.schoolId,actorId:data.viewerId,body:{name:"Delegated category",studentIds:[data.studentIds[0]],staffIds:[data.staffId],categoryId:cat.id}}));
  await assert.rejects(scoped(data.schoolId,()=>mutateCoverageCategory({schoolId:data.schoolId,actorId:data.adminId,categoryId:cat.id,remove:true,body:{updatedAt:cat.updatedAt.toISOString()}})),{code:"COVERAGE_CATEGORY_STALE"});
  const current=(await categoriesFor(data)).categories[0]!;
  const renamed=await scoped(data.schoolId,()=>mutateCoverageCategory({schoolId:data.schoolId,actorId:data.adminId,categoryId:cat.id,body:{name:"MAP",updatedAt:current.updatedAt}}));
  assert.ok("category" in renamed && renamed.category);
  await assert.rejects(scoped(data.schoolId,()=>deleteCoverageSupervisionGroup({schoolId:data.schoolId,actorId:data.adminId,groupId:added.group.id,body:{updatedAt:added.group.updatedAt}})),{code:"COVERAGE_DELETE_STALE"});
  const removed=await scoped(data.schoolId,()=>mutateCoverageCategory({schoolId:data.schoolId,actorId:data.adminId,categoryId:cat.id,remove:true,body:{updatedAt:renamed.category.updatedAt.toISOString()}}));
  assert.deepEqual(removed,{success:true,categoryId:cat.id,movedGroupCount:1});
  const after=await browse(data); assert.equal(after.groups[0]!.category,null); assert.equal(after.groups[0]!.studentCount,1); assert.equal(after.groups[0]!.staff.length,1);
  assert.equal((await categoriesFor(foreign)).categories.length,1);
});

test("atomic create/update rolls back all setup on audit failure and stale editor versions cannot overwrite changes",async()=>{
  const data=await fixture(), cat=await category(data); const original=await addGroup(data);
  const suffix=randomUUID().replaceAll("-",""); const trigger=`coverage_directory_fail_${suffix}`;
  await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit failure'; END $$`);
  await pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_logs FOR EACH ROW WHEN (NEW.school_id='${data.schoolId}') EXECUTE FUNCTION ${trigger}()`);
  try {
    await assert.rejects(addGroup(data,"Rollback create",{categoryId:cat.id}),/Failed query|fixture audit failure/);
    await assert.rejects(scoped(data.schoolId,()=>saveCoverageDirectoryGroup({schoolId:data.schoolId,actorId:data.adminId,groupId:original.group.id,body:{name:"Rollback update",categoryId:cat.id,studentIds:[data.studentIds[1]],staffIds:[],updatedAt:original.group.updatedAt}})),/Failed query|fixture audit failure/);
  } finally { await pool.query(`DROP TRIGGER ${trigger} ON audit_logs`); await pool.query(`DROP FUNCTION ${trigger}()`); }
  const after=await browse(data); assert.equal(after.total,1); assert.deepEqual(after.groups[0]!.staff,original.group.staff); assert.equal(after.groups[0]!.updatedAt,original.group.updatedAt); assert.equal(after.groups[0]!.categoryId,null);
  assert.equal((await categoriesFor(data)).categories[0]!.updatedAt,cat.updatedAt.toISOString());
  const changed=await scoped(data.schoolId,()=>saveCoverageDirectoryGroup({schoolId:data.schoolId,actorId:data.adminId,groupId:original.group.id,body:{name:"New name",updatedAt:original.group.updatedAt}}));
  await assert.rejects(scoped(data.schoolId,()=>saveCoverageDirectoryGroup({schoolId:data.schoolId,actorId:data.adminId,groupId:original.group.id,body:{name:"Stale name",studentIds:[],staffIds:[],updatedAt:original.group.updatedAt}})),{code:"COVERAGE_GROUP_STALE"});
  assert.equal((await browse(data)).groups[0]!.name,changed.group.name);
});

test("lifecycle lock rechecks revoked setup authority before a pending create commits",async()=>{
  const data=await fixture();
  await pool.query("INSERT INTO classpilot_coverage_assignments(school_id,staff_id,scope_type,permissions,created_by) VALUES($1,$2,'setup','{\"setup\":true}',$3)",[data.schoolId,data.viewerId,data.adminId]);
  let pending: Promise<unknown> | undefined;
  await scoped(data.schoolId,()=>db.transaction(async tx=>{
    await lockStaffAssignmentLifecycleSchool(tx,data.schoolId);
    pending=scoped(data.schoolId,()=>saveCoverageDirectoryGroup({schoolId:data.schoolId,actorId:data.viewerId,body:{name:"Pending unauthorized",studentIds:[data.studentIds[0]],staffIds:[data.staffId]}}));
    // Attach a rejection handler immediately while its lock is pending.
    void pending.catch(()=>undefined);
    await tx.execute(sql`UPDATE classpilot_coverage_assignments SET active=false WHERE school_id=${data.schoolId} AND staff_id=${data.viewerId}`);
  }));
  assert.ok(pending); await assert.rejects(pending,{code:"FORBIDDEN"}); assert.equal((await browse(data)).total,0);
});

test("directory routes enforce auth/roles, validate queries and preserve legacy list and partial PATCH",async()=>{
  const data=await fixture(), group=await addGroup(data);
  const {default:router}=await import("../src/routes/classpilot/coverage.js"), {signUserToken}=await import("../src/services/jwt.js");
  const app=express(); app.use(express.json()); app.use("/api/classpilot",router);
  app.use(((error,_req,res,_next)=>{const known=error as Error & {status?:number;code?:string};res.status(known.status??500).json({error:known.message,code:known.code});}) satisfies express.ErrorRequestHandler);
  const server=createServer(app); await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/classpilot/coverage`;
  const headers=(userId=data.adminId)=>({authorization:`Bearer ${signUserToken({userId,email:`${userId}@example.test`,isSuperAdmin:false})}`,"x-school-id":data.schoolId,"content-type":"application/json"});
  try {
    assert.equal((await fetch(`${base}/supervision-groups/browse`)).status,401);
    assert.equal((await fetch(`${base}/supervision-groups/browse`,{headers:headers(data.staffId)})).status,403);
    assert.equal((await fetch(`${base}/supervision-groups/browse?page=-1`,{headers:headers()})).status,400);
    assert.equal((await fetch(`${base}/supervision-groups/${group.group.id}?view=summary`,{headers:headers()})).status,200);
    assert.equal((await fetch(`${base}/supervision-groups/${group.group.id}?view=invalid`,{headers:headers()})).status,400);
    assert.equal((await fetch(`${base}/supervision-groups`,{headers:headers()})).status,200);
    assert.equal((await fetch(`${base}/supervision-groups/${group.group.id}`,{method:"PATCH",headers:headers(),body:JSON.stringify({description:"Legacy partial update"})})).status,200);
    assert.equal((await fetch(`${base}/supervision-group-categories`,{method:"POST",headers:headers(),body:JSON.stringify({name:""})})).status,400);
    await pool.query("UPDATE product_licenses SET status='inactive' WHERE school_id=$1",[data.schoolId]);
    assert.equal((await fetch(`${base}/supervision-groups/browse`,{headers:headers()})).status,403);
  } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
});

test("category migration enforces FORCE RLS and same-school foreign keys",async()=>{
  const data=await fixture(), other=await fixture(), cat=await category(data), foreign=await category(other);
  await assert.rejects(pool.query("INSERT INTO classpilot_coverage_scope_groups(school_id,name,created_by,category_id) VALUES($1,'Cross-school',$2,$3)",[data.schoolId,data.adminId,foreign.id]),{code:"23503"});
  const flags=await pool.query<{relrowsecurity:boolean;relforcerowsecurity:boolean}>("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='classpilot_coverage_group_categories'::regclass");
  assert.deepEqual(flags.rows,[{relrowsecurity:true,relforcerowsecurity:true}]);
  const role=`coverage_directory_rls_${randomUUID().replaceAll("-","")}`, client=await pool.connect();
  try {
    await client.query(`CREATE ROLE ${role} NOSUPERUSER NOLOGIN`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT,INSERT ON classpilot_coverage_group_categories TO ${role}`);
    await client.query("BEGIN"); await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SELECT set_config('app.school_id',$1,true),set_config('app.is_super','off',true)",[data.schoolId]);
    assert.deepEqual((await client.query<{id:string}>("SELECT id FROM classpilot_coverage_group_categories")).rows,[{id:cat.id}]);
    await assert.rejects(client.query("INSERT INTO classpilot_coverage_group_categories(school_id,name) VALUES($1,'Denied')",[other.schoolId]),{code:"42501"});
    await client.query("ROLLBACK");
  } finally { await client.query("ROLLBACK"); await client.query(`DROP OWNED BY ${role}`); await client.query(`DROP ROLE ${role}`); client.release(); }
});

test("verified super administrators retain directory and group setup access without a school membership",async()=>{
  const data=await fixture(), actorId=randomUUID(); userIds.push(actorId);
  await pool.query("INSERT INTO users(id,email,is_super_admin) VALUES($1,$2,true)",[actorId,`${actorId}@example.test`]);
  const created=await scoped(data.schoolId,()=>saveCoverageDirectoryGroup({schoolId:data.schoolId,actorId,body:{name:"Super admin setup",studentIds:[data.studentIds[0]],staffIds:[data.staffId]}}));
  assert.equal((await browse(data,{},actorId)).groups[0]!.id,created.group.id);
  const cat=await scoped(data.schoolId,()=>mutateCoverageCategory({schoolId:data.schoolId,actorId,body:{name:"Super admin category"}}));
  assert.ok("category" in cat);
  await pool.query("UPDATE users SET is_super_admin=false WHERE id=$1",[actorId]);
  await assert.rejects(browse(data,{},actorId),{code:"FORBIDDEN"});
});
