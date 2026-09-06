import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOneRosterFiles, readOneRosterZip } from "../src/services/oneRosterCsv.js";
import { fetchCleverCollection, fetchCleverRoster } from "../src/services/cleverRosterClient.js";
import { planRosterImport, type RosterCatalogue, type SourceMembership } from "../src/services/rosterIntegrationPlanner.js";
import { rosterHash, rosterLocalSchedule, rosterRemovalHeld } from "../src/services/rosterIntegrationModel.js";
import { rosterReviewPage } from "../src/services/rosterIntegrationReview.js";

const csv=(headers:string[],rows:string[][])=>[headers,...rows].map(row=>row.map(value=>/[",\n]/.test(value)?`"${value.replace(/"/g,'""')}"`:value).join(",")).join("\r\n");
function packageFiles(version="1.1"){
  const files=new Map<string,string>();const names=["orgs","users","academicSessions","courses","classes","enrollments",...(version==="1.2"?["roles"]:[])];
  files.set("manifest.csv",csv(["propertyName","value"],[["manifest.version","1.0"],["oneroster.version",version],...names.map(name=>[`file.${name}`,"bulk"])]));
  files.set("orgs.csv",csv(["sourcedId","name","type","parentSourcedId"],[["org","Example School","school",""]]));
  files.set("academicSessions.csv",csv(["sourcedId","title","type","startDate","endDate","schoolYear","parentSourcedId"],[["term","Fall","term","2026-08-01","2026-12-20","2027",""]]));
  files.set("courses.csv",csv(["sourcedId","title","orgSourcedId"],[["course","Math","org"]]));
  files.set("classes.csv",csv(["sourcedId","title","schoolSourcedId","courseSourcedId","termSourcedIds","classType"],[["class","Math A","org","course","term","scheduled"]]));
  files.set("users.csv",csv(["sourcedId","givenName","familyName","email","identifier","role","orgSourcedIds","username","enabledUser"],[["teacher","Teach","Person","teach@example.edu","","teacher","org","teach","true"],["student","Stu","Person","stu@example.edu","100","student","org","stu","true"]]));
  files.set("enrollments.csv",csv(["sourcedId","classSourcedId","schoolSourcedId","userSourcedId","role","primary"],[["et","class","org","teacher","teacher","true"],["es","class","org","student","student",""]]));
  if(version==="1.2")files.set("roles.csv",csv(["sourcedId","userSourcedId","role","orgSourcedId","roleType"],[["rt","teacher","teacher","org","primary"],["rs","student","student","org","primary"]]));
  return files;
}
test("OneRoster 1.1 and 1.2 dispatch roles and preserve exact external identities",()=>{
  for(const version of ["1.1","1.2"]){const result=parseOneRosterFiles(packageFiles(version));assert.equal(result.version,version);assert.equal(result.complete,true);assert.deepEqual(result.classes[0]?.studentIds,["student"]);assert.equal(result.classes[0]?.primaryTeacherId,"teacher");assert.deepEqual(result.people.find(row=>row.id==="student")?.roles,["student"]);}
});
test("OneRoster rejects delta, incomplete manifests, duplicate IDs, orphan references and ambiguous primary teachers",()=>{
  const delta=packageFiles();delta.set("manifest.csv",delta.get("manifest.csv")!.replace("file.users,bulk","file.users,delta"));assert.throws(()=>parseOneRosterFiles(delta),{code:"ROSTER_DELTA_UNSUPPORTED"});
  const missing=packageFiles();missing.delete("courses.csv");assert.throws(()=>parseOneRosterFiles(missing),{code:"ROSTER_FILE_MISSING"});
  const orphan=packageFiles();orphan.set("classes.csv",orphan.get("classes.csv")!.replace("org,course,term","org,missing,term"));assert.throws(()=>parseOneRosterFiles(orphan),{code:"ROSTER_REFERENCE_INVALID"});
  const duplicate=packageFiles();duplicate.set("orgs.csv",duplicate.get("orgs.csv")!+"\r\norg,Duplicate,school,");assert.throws(()=>parseOneRosterFiles(duplicate),{code:"ROSTER_DUPLICATE_ID"});
  const ambiguous=packageFiles();ambiguous.set("enrollments.csv",ambiguous.get("enrollments.csv")!.replace("teacher,teacher,true","teacher,teacher,false")+"\r\net2,class,org,student,teacher,false");assert.throws(()=>parseOneRosterFiles(ambiguous),{code:"ROSTER_ENROLLMENT_ROLE_MISMATCH"});
});
test("OneRoster validates bulk status, parent cycles, optional references and quoted commas",()=>{
  const status=packageFiles();status.set("courses.csv","sourcedId,title,orgSourcedId,status\ncourse,Math,org,active");assert.throws(()=>parseOneRosterFiles(status),{code:"ROSTER_BULK_STATUS_INVALID"});
  const cycle=packageFiles();cycle.set("academicSessions.csv",cycle.get("academicSessions.csv")!+"term");assert.throws(()=>parseOneRosterFiles(cycle),{code:"ROSTER_REFERENCE_CYCLE"});
  const quoting=packageFiles();quoting.set("classes.csv",csv(["sourcedId","title","schoolSourcedId","courseSourcedId","termSourcedIds","classType"],[["class","Math, science","org","course","term","scheduled"]]));assert.equal(parseOneRosterFiles(quoting).classes[0]?.name,"Math, science");
});

function storedZip(files:Map<string,string>):Buffer{
  const local:Buffer[]=[];const directory:Buffer[]=[];let offset=0;
  function crc32(data:Buffer){let crc=0xffffffff;for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
  for(const [name,text] of files){const filename=Buffer.from(name);const content=Buffer.from(text);const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt32LE(crc32(content),14);header.writeUInt32LE(content.length,18);header.writeUInt32LE(content.length,22);header.writeUInt16LE(filename.length,26);local.push(header,filename,content);const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc32(content),16);central.writeUInt32LE(content.length,20);central.writeUInt32LE(content.length,24);central.writeUInt16LE(filename.length,28);central.writeUInt32LE(offset,42);directory.push(central,filename);offset+=header.length+filename.length+content.length;}
  const central=Buffer.concat(directory);const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.size,8);end.writeUInt16LE(files.size,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,central,end]);
}
test("ZIP reads valid root CSV and rejects traversal and entry limits without extraction",async()=>{
  assert.equal((await readOneRosterZip(storedZip(packageFiles()))).classes.length,1);
  const traversal=new Map([["../manifest.csv","private"]]);await assert.rejects(readOneRosterZip(storedZip(traversal)),{code:"ROSTER_ZIP_INVALID"});
  const many=new Map(Array.from({length:101},(_,i)=>[`File${i}.csv`,"a\nb"]));await assert.rejects(readOneRosterZip(storedZip(many)),{code:"ROSTER_ZIP_ENTRIES"});
});

function catalogue():RosterCatalogue{return {students:[],teachers:[{id:"local-teacher",email:"teach@example.edu",name:"Teach Person",status:"active",domainEligible:true}],classes:[],identities:[],memberships:[],schoolDomain:"example.edu"};}
test("planner links teachers, creates students/classes and never creates staff roles",()=>{
  let next=0;const plan=planRosterImport(parseOneRosterFiles(packageFiles()),{organizationIds:["org"]},catalogue(),"connection",()=>`new-${++next}`);
  assert.deepEqual(plan.unresolved,[]);assert.equal(plan.summary.createStudents,1);assert.equal(plan.summary.createClasses,1);assert.equal(plan.steps.find(step=>step.kind==="teacher")?.internalId,"local-teacher");assert.deepEqual(plan.steps.find(step=>step.kind==="teacher")?.data,{});
});
test("exact email and student-number conflicts hold the entire snapshot for mapping",()=>{
  const local=catalogue();local.students=[{id:"a",firstName:"A",lastName:"Person",email:"stu@example.edu",emailLc:"stu@example.edu",studentIdNumber:"101",gradeLevel:"5",status:"active"},{id:"b",firstName:"B",lastName:"Person",email:"other@example.edu",emailLc:"other@example.edu",studentIdNumber:"100",gradeLevel:"5",status:"active"}];
  const plan=planRosterImport(parseOneRosterFiles(packageFiles()),{organizationIds:["org"]},local,"connection");assert(plan.holds.includes("unresolved_identity"));assert.equal(plan.unresolved[0]?.type,"student");
  const reviewed=planRosterImport(parseOneRosterFiles(packageFiles()),{organizationIds:["org"],people:{student:"a"}},local,"connection");assert.equal(reviewed.unresolved.length,0);assert.deepEqual(reviewed.steps.find(step=>step.kind==="student")?.data,{});
});
test("source-owned fields preserve subsequent manual edits; explicit adoption is previewed",()=>{
  const local=catalogue();local.students=[{id:"a",firstName:"Manual",lastName:"Person",email:"stu@example.edu",emailLc:"stu@example.edu",studentIdNumber:"100",gradeLevel:"5",status:"active"}];local.identities=[{entityType:"student",externalId:"student",internalId:"a",ownedFields:["firstName","lastName"],lastApplied:{firstName:"Stu",lastName:"Person"},sourceCreated:true,sourcePresent:true}];
  const plan=planRosterImport(parseOneRosterFiles(packageFiles()),{organizationIds:["org"]},local,"connection");assert(!plan.steps.find(step=>step.kind==="student")?.ownedFields.includes("firstName"));
  const adopted=planRosterImport(parseOneRosterFiles(packageFiles()),{organizationIds:["org"],adoptPeople:["student"]},local,"connection");assert.equal(adopted.steps.find(step=>step.kind==="student")?.data.firstName,"Stu");
});
test("manual, other-source and replaced physical memberships survive removals",()=>{
  const local=catalogue();local.classes=[{id:"g",name:"Math A",gradeLevel:null,term:"Fall",teacherId:"local-teacher",status:"active",scheduleEnabled:false,blockStartTime:null,blockEndTime:null,groupType:"admin_class",students:[{id:"physical",memberId:"removed"}],teachers:[{id:"pt",memberId:"local-teacher",role:"primary"}]}];local.identities=[{entityType:"class",externalId:"class",internalId:"g",ownedFields:["name"],lastApplied:{name:"Math A"},sourceCreated:true,sourcePresent:true}];
  const contribution:SourceMembership={connectionId:"connection",groupId:"g",memberType:"student",memberId:"removed",role:"student",ownsMembership:true,manualPreserved:false,physicalRowId:"physical",sourcePresent:true};
  local.memberships=[contribution];let plan=planRosterImport(parseOneRosterFiles(packageFiles()),{organizationIds:["org"]},local,"connection");assert.equal(plan.summary.removeStudentMemberships,1);
  for(const variant of [{...contribution,manualPreserved:true},{...contribution,physicalRowId:"prior"}]){local.memberships=[variant];plan=planRosterImport(parseOneRosterFiles(packageFiles()),{organizationIds:["org"]},local,"connection");assert(plan.steps.find(step=>step.kind==="class")?.studentIds?.includes("removed"));}
  local.memberships=[contribution,{...contribution,connectionId:"other"}];plan=planRosterImport(parseOneRosterFiles(packageFiles()),{organizationIds:["org"]},local,"connection");assert.equal(plan.summary.removeStudentMemberships,0);
});
test("incomplete, empty, missing teacher and large-removal snapshots are held",()=>{
  const snapshot=parseOneRosterFiles(packageFiles());assert(planRosterImport({...snapshot,complete:false},{organizationIds:["org"]},catalogue(),"connection").holds.includes("incomplete_snapshot"));
  assert(planRosterImport({...snapshot,classes:[]},{organizationIds:["org"]},catalogue(),"connection").holds.includes("empty_snapshot"));
  const local=catalogue();local.teachers=[];assert(planRosterImport(snapshot,{organizationIds:["org"]},local,"connection").holds.includes("unresolved_identity"));
  assert.equal(rosterRemovalHeld(10,100),false);assert.equal(rosterRemovalHeld(11,100),true);assert.equal(rosterRemovalHeld(51,10000),true);assert.equal(rosterRemovalHeld(50,1000),false);
});
test("preview hashes are deterministic across equivalent object key ordering",()=>{assert.equal(rosterHash({a:1,b:{z:2,x:3}}),rosterHash({b:{x:3,z:2},a:1}));});
test("Clever due dates use the configured school clock and handle DST gaps without a second local date",()=>{
  const now=new Date("2026-09-05T06:00:00Z");assert.deepEqual(rosterLocalSchedule(now,"America/New_York"),{date:"2026-09-05",due:true});assert.deepEqual(rosterLocalSchedule(now,"America/Los_Angeles"),{date:"2026-09-04",due:true});
  assert.equal(rosterLocalSchedule(new Date("2026-03-08T06:59:00Z"),"America/New_York").due,false);
  assert.deepEqual(rosterLocalSchedule(new Date("2026-03-08T07:00:00Z"),"America/New_York"),{date:"2026-03-08",due:true});
  assert.deepEqual(rosterLocalSchedule(new Date("2026-11-01T07:00:00Z"),"America/New_York"),{date:"2026-11-01",due:true});
});

test("review freezes named membership changes, role transitions and before/after owned values into the plan hash",()=>{
  const local=catalogue();
  local.teachers.push({id:"prior-teacher",email:"prior@example.edu",name:"Prior Teacher",status:"active",domainEligible:true});
  local.students.push({id:"removed",firstName:"Removed",lastName:"Student",email:"removed@example.edu",emailLc:"removed@example.edu",studentIdNumber:"old",gradeLevel:null,status:"active"});
  local.classes.push({id:"g",name:"Old Math",gradeLevel:null,term:"Fall",teacherId:"prior-teacher",status:"active",scheduleEnabled:false,blockStartTime:null,blockEndTime:null,groupType:"admin_class",students:[{id:"physical",memberId:"removed"}],teachers:[{id:"tp",memberId:"prior-teacher",role:"primary"}]});
  local.identities.push({entityType:"class",externalId:"class",internalId:"g",ownedFields:["name","teacherId"],lastApplied:{name:"Old Math",teacherId:"prior-teacher"},sourceCreated:true,sourcePresent:true});
  local.memberships.push({connectionId:"connection",groupId:"g",memberType:"student",memberId:"removed",role:"student",ownsMembership:true,manualPreserved:false,physicalRowId:"physical",sourcePresent:true});
  const plan=planRosterImport(parseOneRosterFiles(packageFiles()),{organizationIds:["org"]},local,"connection",()=>"new-student");
  const review=plan.steps.find(row=>row.kind==="class")!.review!;
  assert.deepEqual(review.fields.find(row=>row.field==="name"),{field:"name",before:"Old Math",after:"Math A"});
  assert.equal(review.fields.find(row=>row.field==="teacherId")?.beforeLabel,"Prior Teacher");
  assert.deepEqual(review.members.find(row=>row.memberId==="removed"),{memberType:"student",memberId:"removed",name:"Removed Student",beforeRole:"student",afterRole:null});
  assert.equal(review.members.find(row=>row.memberId==="new-student")?.name,"Stu Person");
  assert.deepEqual(review.members.find(row=>row.memberId==="prior-teacher"),{memberType:"teacher",memberId:"prior-teacher",name:"Prior Teacher",beforeRole:"primary",afterRole:"co-teacher"});
  const hash=rosterHash(plan);local.students[0]!.firstName="Later edit";assert.equal(rosterHash(plan),hash);assert.equal(review.members.find(row=>row.memberId==="removed")?.name,"Removed Student");
  review.members[0]!.name="Different review";assert.notEqual(rosterHash(plan),hash);
});

test("named review pages are complete, bounded and reject another preview hash or legacy review format",()=>{
  const plan=planRosterImport(parseOneRosterFiles(packageFiles()),{organizationIds:["org"]},catalogue(),"connection",()=>"planned");
  const step=plan.steps.find(row=>row.kind==="class")!;step.review!.members=Array.from({length:121},(_,i)=>({memberType:"student" as const,memberId:`s${i}`,name:`Student ${i}`,beforeRole:"student",afterRole:null}));
  const hash=rosterHash(plan), first=rosterReviewPage(plan,hash,hash,0), second=rosterReviewPage(plan,hash,hash,1), third=rosterReviewPage(plan,hash,hash,2);
  assert.equal(first.rows.length,50);assert.equal(second.rows.length,50);assert.equal([...first.rows,...second.rows,...third.rows].filter(row=>row.type==="membership").length,121);
  assert.equal(first.total,first.rows.length+second.rows.length+third.rows.length);
  assert.throws(()=>rosterReviewPage(plan,hash,"stale",0),{code:"ROSTER_PREVIEW_STALE"});
  assert.throws(()=>rosterReviewPage(plan,hash,hash,0.5),{code:"ROSTER_INPUT_INVALID"});
  assert.throws(()=>rosterReviewPage({...plan,reviewVersion:undefined},hash,hash,0),{code:"ROSTER_PREVIEW_STALE"});
});

test("a returning class restores only its verified source archive and leaves scheduling disabled",()=>{
  const local=catalogue(), archivedAt="2026-09-01T12:00:00.000Z";
  local.classes.push({id:"g",name:"Math A",gradeLevel:null,term:"Fall",teacherId:"local-teacher",status:"archived",archivedAt,scheduleEnabled:false,blockStartTime:null,blockEndTime:null,groupType:"admin_class",students:[],teachers:[]});
  local.identities.push({entityType:"class",externalId:"class",internalId:"g",ownedFields:["name","gradeLevel","term","teacherId"],lastApplied:{name:"Math A",gradeLevel:null,term:"Fall",teacherId:"local-teacher",status:"archived",archivedAt},sourceCreated:true,sourcePresent:false});
  const plan=()=>planRosterImport(parseOneRosterFiles(packageFiles()),{organizationIds:["org"]},local,"connection");
  const restored=plan();assert.equal(restored.unresolved.length,0);assert.equal(restored.steps.find(row=>row.kind==="class")?.data.status,"active");assert.equal(restored.steps.find(row=>row.kind==="class")?.data.archivedAt,null);assert.equal(restored.steps.find(row=>row.kind==="class")?.data.scheduleEnabled,false);
  assert.deepEqual(restored.steps.find(row=>row.kind==="class")?.review?.fields.find(row=>row.field==="status"),{field:"status",before:"archived",after:"active"});
  local.classes[0]!.archivedAt="2026-09-02T12:00:00.000Z";assert(plan().unresolved.some(row=>row.reason.includes("archived manually")));
  local.classes[0]!.archivedAt=archivedAt;local.identities[0]!.sourcePresent=true;assert(plan().holds.includes("unresolved_identity"));
  local.identities[0]!.sourcePresent=false;local.otherSourceClassIds=["g"];assert(plan().holds.includes("unresolved_identity"));
});

test("invalid calendar dates and orphan OneRoster 1.2 roles fail before planning",()=>{
  const dates=packageFiles();dates.set("academicSessions.csv",dates.get("academicSessions.csv")!.replace("2026-08-01","2026-02-30"));assert.throws(()=>parseOneRosterFiles(dates),{code:"ROSTER_TERM_DATE_INVALID"});
  const roles=packageFiles("1.2");roles.set("roles.csv",roles.get("roles.csv")!.replace("rs,student,student,org","rs,missing,student,org"));assert.throws(()=>parseOneRosterFiles(roles),{code:"ROSTER_REFERENCE_INVALID"});
});

test("source-absent classes with manual fields or another source identity are preserved",()=>{
  const snapshot=parseOneRosterFiles(packageFiles());const local=catalogue();
  local.classes=[{id:"g",name:"Old class",gradeLevel:null,term:"Fall",teacherId:"local-teacher",status:"active",scheduleEnabled:false,blockStartTime:null,blockEndTime:null,groupType:"admin_class",students:[],teachers:[]}];
  local.identities=[{entityType:"class",externalId:"old",internalId:"g",ownedFields:["name","gradeLevel","term","teacherId"],lastApplied:{name:"Old class",gradeLevel:null,term:"Fall",teacherId:"local-teacher"},sourceCreated:true,sourcePresent:true}];
  assert.equal(planRosterImport(snapshot,{organizationIds:["org"]},local,"connection").summary.archiveClasses,1);
  local.otherSourceClassIds=["g"];assert.equal(planRosterImport(snapshot,{organizationIds:["org"]},local,"connection").summary.archiveClasses,0);
  local.otherSourceClassIds=[];local.classes[0]!.name="Manual title";assert.equal(planRosterImport(snapshot,{organizationIds:["org"]},local,"connection").summary.archiveClasses,0);
});

const envelope=(rows:unknown[],next?:string)=>new Response(JSON.stringify({data:rows.map(data=>({data})),links:next?[{rel:"next",uri:next}]:[]}),{status:200});
test("Clever follows all pages and rejects token forwarding, loops and repeated IDs",async()=>{
  let calls=0;const rows=await fetchCleverCollection("users","district-secret",{bytes:0,rows:0},async(input,options)=>{assert.equal(new Headers(options?.headers).get("Authorization"),"Bearer district-secret");calls++;return calls===1?envelope([{id:"a"}],"/v3.0/users?starting_after=a"):envelope([{id:"b"}]);});assert.equal(rows.length,2);assert.equal(calls,2);
  await assert.rejects(fetchCleverCollection("users","token",{bytes:0,rows:0},async()=>envelope([{id:"a"}],"https://example.com/v3.0/users")),{code:"CLEVER_PAGING_INVALID"});
  await assert.rejects(fetchCleverCollection("users","token",{bytes:0,rows:0},async()=>new Response(JSON.stringify({data:[{data:{id:"a"}}],links:[{rel:"next",uri:""}]}))),{code:"CLEVER_PAGING_INVALID"});
  await assert.rejects(fetchCleverCollection("users","token",{bytes:0,rows:0},async()=>envelope([{id:"a"}],"/v3.0/users?starting_after=a")),{code:"CLEVER_PAGING_DUPLICATE"});
});
test("Clever district binding and multi-role teachers never grant administrative roles",async()=>{
  const resources:Record<string,unknown[]>={districts:[{id:"d"}],schools:[{id:"org",district:"d",name:"School"}],users:[{id:"teacher",district:"d",name:{first:"Teach",last:"Person"},email:"teach@example.edu",roles:{teacher:{school:"org",schools:["org"]},district_admin:{}}},{id:"student",district:"d",name:{first:"Stu",last:"Person"},email:"stu@example.edu",roles:{student:{school:"org",schools:["org"],student_number:"100"}}}],sections:[{id:"class",district:"d",school:"org",name:"Math",teacher:"teacher",teachers:["teacher"],students:["student"]}],courses:[],terms:[]};
  const fake:typeof fetch=async input=>envelope(resources[new URL(String(input)).pathname.split("/").at(-1)!]||[]);
  const result=await fetchCleverRoster("d","district-token",fake);assert.deepEqual(result.people.find(row=>row.id==="teacher")?.roles,["teacher"]);assert.equal(result.classes[0]?.primaryTeacherId,"teacher");
  await assert.rejects(fetchCleverRoster("different","district-token",fake),{code:"CLEVER_DISTRICT_MISMATCH"});
});
