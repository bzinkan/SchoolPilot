import { randomUUID } from "node:crypto";
import { rosterHash, rosterRemovalHeld, selectRosterSchool, type RosterMapping, type RosterPackage } from "./rosterIntegrationModel.js";
import { attachRosterReview, type RosterStepReview } from "./rosterIntegrationReview.js";

export type CataloguePerson = { id: string; firstName: string; lastName: string; email: string | null; emailLc: string | null; studentIdNumber: string | null; gradeLevel: string | null; status: string };
export type CatalogueTeacher = { id: string; email: string; name: string; status: string; domainEligible: boolean };
export type CatalogueClass = { id: string; name: string; gradeLevel: string | null; term: string | null; teacherId: string; status: string; archivedAt?: string | null; scheduleEnabled: boolean; scheduleRule?: unknown; blockStartTime: string | null; blockEndTime: string | null; groupType: string; students: Array<{ id: string; memberId: string }>; teachers: Array<{ id: string; memberId: string; role: string }> };
export type SourceIdentity = { entityType: "student" | "teacher" | "class"; externalId: string; internalId: string; sourceCreated: boolean; sourcePresent: boolean; ownedFields: string[]; lastApplied: Record<string, unknown> };
export type SourceMembership = { connectionId: string; groupId: string; memberId: string; memberType: "student" | "teacher"; role: string; ownsMembership: boolean; manualPreserved: boolean; sourcePresent: boolean; physicalRowId: string | null };
export type RosterCatalogue = { students: CataloguePerson[]; teachers: CatalogueTeacher[]; classes: CatalogueClass[]; identities: SourceIdentity[]; otherSourceClassIds?:string[]; memberships: SourceMembership[]; schoolDomain: string | null };
export type RosterStep = { kind: "student" | "teacher" | "class" | "archive"; externalId: string; internalId: string; create: boolean; expectedHash: string | null; data: Record<string, unknown>; ownedFields: string[]; sourceCreated: boolean; primaryTeacherId?: string; studentIds?: string[]; coTeacherIds?: string[]; sourceStudentIds?: string[]; sourceTeacherIds?: string[]; review?: RosterStepReview };
export type RosterPlan = { version: 1; reviewVersion?: 1; steps: RosterStep[]; unresolved: Array<{ externalId: string; type: string; name: string; reason: string }>; warnings: string[]; holds: string[]; summary: { createStudents: number; updateStudents: number; linkTeachers: number; createClasses: number; updateClasses: number; archiveClasses: number; removeStudentMemberships: number; removeTeacherMemberships: number; missingStudents: number; missingTeachers: number; totalSteps: number }; catalogueHash: string };
export function classRosterHash(row: CatalogueClass): string { return rosterHash({ ...row, students: [...row.students].sort((a,b) => a.memberId.localeCompare(b.memberId)), teachers: [...row.teachers].sort((a,b) => a.memberId.localeCompare(b.memberId)) }); }
export function catalogueRosterHash(catalogue: RosterCatalogue): string { return rosterHash({ ...catalogue, students: [...catalogue.students].sort((a,b)=>a.id.localeCompare(b.id)), teachers: [...catalogue.teachers].sort((a,b)=>a.id.localeCompare(b.id)), classes: [...catalogue.classes].sort((a,b)=>a.id.localeCompare(b.id)), identities: [...catalogue.identities].sort((a,b)=>(a.entityType+a.externalId).localeCompare(b.entityType+b.externalId)), memberships: [...catalogue.memberships].sort((a,b)=>(a.connectionId+a.groupId+a.memberType+a.memberId).localeCompare(b.connectionId+b.groupId+b.memberType+b.memberId)) }); }
function ownedPatch(current: Record<string, unknown> | undefined, desired: Record<string, unknown>, identity: SourceIdentity | undefined, adopt: boolean): { data: Record<string, unknown>; ownedFields: string[] } {
  const fields = !current || adopt ? Object.keys(desired) : identity?.ownedFields || [];
  const ownedFields = fields.filter(key => key in desired && (!current || adopt || JSON.stringify(current[key] ?? null) === JSON.stringify(identity?.lastApplied[key] ?? null)));
  return { data: Object.fromEntries(ownedFields.map(key => [key, desired[key]])), ownedFields };
}
export function canRemoveSourceMembership(row: SourceMembership, physicalId: string, all: SourceMembership[], connectionId: string): boolean {
  return row.connectionId === connectionId && row.ownsMembership && !row.manualPreserved && row.physicalRowId === physicalId && !all.some(other => other.connectionId !== connectionId && other.groupId === row.groupId && other.memberType === row.memberType && other.memberId === row.memberId && other.sourcePresent);
}

/** Pure, bounded planning. Matching is exact and tenant-local; names never establish identity. */
export function planRosterImport(snapshot: RosterPackage, mapping: RosterMapping, catalogue: RosterCatalogue, connectionId: string, idFactory: () => string = randomUUID): RosterPlan {
  const selected = selectRosterSchool(snapshot, mapping); const steps: RosterStep[] = []; const unresolved: RosterPlan["unresolved"] = [];
  const warnings = [...snapshot.warnings]; const holds: string[] = [];
  const summary: RosterPlan["summary"] = { createStudents: 0, updateStudents: 0, linkTeachers: 0, createClasses: 0, updateClasses: 0, archiveClasses: 0, removeStudentMemberships: 0, removeTeacherMemberships: 0, missingStudents: 0, missingTeachers: 0, totalSteps: 0 };
  const identities = new Map(catalogue.identities.map(row => [`${row.entityType}:${row.externalId}`, row]));
  const studentsById = new Map(catalogue.students.map(row => [row.id, row])); const teachersById = new Map(catalogue.teachers.map(row => [row.id, row])); const classesById = new Map(catalogue.classes.map(row => [row.id, row]));
  const byEmail=new Map<string,string[]>();const byNumber=new Map<string,string[]>();const staffByEmail=new Map<string,string[]>();
  for(const row of catalogue.students){if(row.emailLc)byEmail.set(row.emailLc,[...(byEmail.get(row.emailLc)||[]),row.id]);if(row.studentIdNumber)byNumber.set(row.studentIdNumber,[...(byNumber.get(row.studentIdNumber)||[]),row.id]);}
  for(const row of catalogue.teachers)staffByEmail.set(row.email.toLowerCase(),[...(staffByEmail.get(row.email.toLowerCase())||[]),row.id]);
  const resolved = new Map<string,string>(); const usedPeople = new Map<string,string>();
  const sourceEmails=new Map<string,number>();const sourceNumbers=new Map<string,number>();
  for(const person of selected.people.filter(person=>person.roles.includes("student"))){if(person.email)sourceEmails.set(person.email,(sourceEmails.get(person.email)||0)+1);if(person.studentNumber)sourceNumbers.set(person.studentNumber,(sourceNumbers.get(person.studentNumber)||0)+1);}
  for (const person of selected.people) {
    if (!person.roles.length) continue;
    if (person.roles.length !== 1) { unresolved.push({ externalId: person.id, type: "person", name: `${person.firstName} ${person.lastName}`, reason: "Conflicting student/teacher roles require source correction." }); continue; }
    const kind = person.roles[0]!; const identity = identities.get(`${kind}:${person.id}`); const manual = mapping.people?.[person.id];
    let existingId = identity?.internalId || manual;
    const matches = kind === "student" ? [...new Set([...(person.email?byEmail.get(person.email)||[]:[]),...(person.studentNumber?byNumber.get(person.studentNumber)||[]:[])])] : person.email?staffByEmail.get(person.email)||[]:[];
    if (!existingId && new Set(matches).size > 1) { unresolved.push({ externalId: person.id, type: kind, name: `${person.firstName} ${person.lastName}`, reason: "Email and student number match different records. Choose the existing person." }); continue; }
    existingId ||= matches[0];
    if (identity && manual && identity.internalId !== manual) { unresolved.push({ externalId: person.id, type: kind, name: `${person.firstName} ${person.lastName}`, reason: "An established source identity cannot be remapped by an import." }); continue; }
    const existing = existingId ? (kind === "student" ? studentsById.get(existingId) : teachersById.get(existingId)) : undefined;
    let reason: string | undefined;
    if(kind==="student"&&((person.email&&(sourceEmails.get(person.email)||0)>1)||(person.studentNumber&&(sourceNumbers.get(person.studentNumber)||0)>1)))reason="The source repeats an email or student number for multiple students. Correct the source before importing.";
    if (existingId && (!existing || existing.status !== "active")) reason = "The selected record is inactive or unavailable in this school.";
    if (kind === "teacher" && (!existing || !(existing as CatalogueTeacher).domainEligible)) reason = "Map this teacher to active school staff with a matching school email domain. Imports never invite staff or grant roles.";
    if (kind === "student" && !existing && (!person.email || !catalogue.schoolDomain || person.email.split("@")[1] !== catalogue.schoolDomain)) reason = "New ClassPilot students require an email in this school's domain.";
    if (kind === "student" && person.email && staffByEmail.has(person.email)) reason = "This email belongs to staff and cannot be assigned to a student.";
    const id = existingId || idFactory();
    if (usedPeople.has(`${kind}:${id}`) && usedPeople.get(`${kind}:${id}`) !== person.id) reason = "Multiple source identities match the same local record.";
    if (reason) { unresolved.push({ externalId: person.id, type: kind, name: `${person.firstName} ${person.lastName}`, reason }); continue; }
    usedPeople.set(`${kind}:${id}`, person.id); resolved.set(`${kind}:${person.id}`,id);
    const desired = kind === "student" ? { firstName: person.firstName, lastName: person.lastName, email: person.email, emailLc: person.email, studentIdNumber: person.studentNumber, gradeLevel: person.grade } : {};
    const owned = ownedPatch(existing as unknown as Record<string,unknown> | undefined, desired, identity, mapping.adoptPeople?.includes(person.id) === true);
    if (kind === "student" && owned.data.email && (!catalogue.schoolDomain || String(owned.data.email).split("@")[1] !== catalogue.schoolDomain)) { unresolved.push({ externalId: person.id, type: kind, name: `${person.firstName} ${person.lastName}`, reason: "The source-owned email no longer matches the school domain." }); continue; }
    steps.push({ kind, externalId: person.id, internalId:id, create:!existing, expectedHash: existing ? rosterHash(existing) : null, ...owned, sourceCreated: identity?.sourceCreated ?? !existing });
    if(kind === "teacher") summary.linkTeachers++; else if(!existing) summary.createStudents++; else if(Object.keys(owned.data).some(key=>JSON.stringify((existing as unknown as Record<string,unknown>)[key])!==JSON.stringify(owned.data[key]))) summary.updateStudents++;
  }
  const usedClasses = new Set<string>();
  const sourceClasses = new Set(selected.classes.map(row=>row.id));
  const allMemberships = catalogue.memberships;
  const membershipsByGroup=new Map<string,SourceMembership[]>();for(const row of allMemberships){const entries=membershipsByGroup.get(row.groupId)||[];entries.push(row);membershipsByGroup.set(row.groupId,entries);}
  for (const source of selected.classes) {
    const identity = identities.get(`class:${source.id}`); const explicit = mapping.classes?.[source.id]; const existingId = identity?.internalId || explicit;
    const existing = existingId ? classesById.get(existingId) : undefined;
    if ((existingId && (!existing || existing.groupType !== "admin_class")) || (identity && explicit && explicit!==identity.internalId) || (existingId && usedClasses.has(existingId))) { unresolved.push({ externalId:source.id,type:"class",name:source.name,reason:"Class mapping is unavailable, duplicated, or conflicts with its existing source identity." }); continue; }
    const restore = existing?.status === "archived" && identity?.sourceCreated === true && !identity.sourcePresent && identity.lastApplied.status === "archived" && Boolean(existing.archivedAt) && existing.archivedAt === identity.lastApplied.archivedAt && !catalogue.otherSourceClassIds?.includes(existing.id);
    if (existing && existing.status !== "active" && !restore) { unresolved.push({ externalId: source.id, type: "class", name: source.name, reason: "This class was archived manually or its source archive cannot be verified. Restore it in Classes and preview again." }); continue; }
    const primary = resolved.get(`teacher:${source.primaryTeacherId}`); const coTeachers = source.coTeacherIds.map(id=>resolved.get(`teacher:${id}`)); const students = source.studentIds.map(id=>resolved.get(`student:${id}`));
    if (!primary || coTeachers.some(id=>!id) || students.some(id=>!id)) { unresolved.push({externalId:source.id,type:"class",name:source.name,reason:"Resolve every class teacher and student before applying."}); continue; }
    const id = existingId || idFactory(); usedClasses.add(id);
    const groupMemberships=membershipsByGroup.get(id)||[];
    const adopt = mapping.adoptClasses?.includes(source.id) === true;
    const owned = ownedPatch(existing as unknown as Record<string,unknown>|undefined,{name:source.name,gradeLevel:source.grade,term:source.term,teacherId:primary},identity,adopt);
    if (restore) { Object.assign(owned.data, { status: "active", archivedAt: null, scheduleEnabled: false }); warnings.push("A returning class archived by this source will be restored. Its schedule remains disabled for administrator review."); }
    const finalPrimary = String(owned.data.teacherId || existing?.teacherId || primary);
    const sourceTeacherIds = [...new Set([primary,...coTeachers as string[]])];
    const desiredStudents = students as string[]; const finalStudents = new Set(desiredStudents); const finalTeachers = new Set(sourceTeacherIds);
    for (const current of existing?.students || []) {
      if (finalStudents.has(current.memberId)) continue;
      const contribution = groupMemberships.find(row=>row.connectionId===connectionId && row.memberType==="student" && row.memberId===current.memberId);
      if (snapshot.complete && contribution && canRemoveSourceMembership(contribution,current.id,groupMemberships,connectionId)) summary.removeStudentMemberships++; else finalStudents.add(current.memberId);
    }
    for (const current of existing?.teachers || []) {
      if (finalTeachers.has(current.memberId) || current.memberId===finalPrimary) continue;
      const contribution=groupMemberships.find(row=>row.connectionId===connectionId && row.memberType==="teacher" && row.memberId===current.memberId);
      if(snapshot.complete && contribution && canRemoveSourceMembership(contribution,current.id,groupMemberships,connectionId)) summary.removeTeacherMemberships++; else finalTeachers.add(current.memberId);
    }
    finalTeachers.add(finalPrimary);
    steps.push({kind:"class",externalId:source.id,internalId:id,create:!existing,expectedHash:existing?classRosterHash(existing):null,...owned,sourceCreated:identity?.sourceCreated??!existing,primaryTeacherId:finalPrimary,studentIds:[...finalStudents].sort(),coTeacherIds:[...finalTeachers].filter(teacher=>teacher!==finalPrimary).sort(),sourceStudentIds:desiredStudents,sourceTeacherIds});
    if(existing) summary.updateClasses++; else summary.createClasses++;
  }
  for(const identity of catalogue.identities.filter(row=>row.entityType==="class"&&row.sourcePresent&&!sourceClasses.has(row.externalId))) {
    const current=classesById.get(identity.internalId); if(!current || current.status!=="active" || !snapshot.complete) continue;
    const currentRows=[...current.students.map(row=>({...row,memberType:"student"})),...current.teachers.map(row=>({...row,memberType:"teacher"}))];
    const groupMemberships=membershipsByGroup.get(current.id)||[];
    const protectedRow=currentRows.some(member=>{const contribution=groupMemberships.find(row=>row.connectionId===connectionId&&row.memberType===member.memberType&&row.memberId===member.memberId);return !contribution||!canRemoveSourceMembership(contribution,member.id,groupMemberships,connectionId);});
    const otherSource=catalogue.otherSourceClassIds?.includes(current.id);
    const manualFields=["name","gradeLevel","term","teacherId"].some(key=>!identity.ownedFields.includes(key)||JSON.stringify((current as unknown as Record<string,unknown>)[key]??null)!==JSON.stringify(identity.lastApplied[key]??null));
    if(!identity.sourceCreated||protectedRow||otherSource||manualFields) { warnings.push("A class absent from the source was preserved because it has manual or shared ownership."); continue; }
    steps.push({kind:"archive",externalId:identity.externalId,internalId:current.id,create:false,expectedHash:classRosterHash(current),data:{status:"archived",archivedAt:new Date().toISOString(),scheduleEnabled:false},ownedFields:identity.ownedFields,sourceCreated:true}); summary.archiveClasses++;
  }
  const personKeys=new Set(selected.people.flatMap(person=>person.roles.map(role=>`${role}:${person.id}`)));
  summary.missingStudents=catalogue.identities.filter(row=>row.entityType==="student"&&row.sourcePresent&&!personKeys.has(`student:${row.externalId}`)).length;
  summary.missingTeachers=catalogue.identities.filter(row=>row.entityType==="teacher"&&row.sourcePresent&&!personKeys.has(`teacher:${row.externalId}`)).length;
  if(!snapshot.complete) holds.push("incomplete_snapshot");
  if(!selected.people.length || !selected.classes.length) holds.push("empty_snapshot");
  if(unresolved.length) holds.push("unresolved_identity");
  for(const [name,removed,previous] of [["students",summary.missingStudents,catalogue.identities.filter(row=>row.entityType==="student"&&row.sourcePresent).length],["teachers",summary.missingTeachers,catalogue.identities.filter(row=>row.entityType==="teacher"&&row.sourcePresent).length],["classes",summary.archiveClasses,catalogue.identities.filter(row=>row.entityType==="class"&&row.sourcePresent).length],["student_memberships",summary.removeStudentMemberships,allMemberships.filter(row=>row.connectionId===connectionId&&row.memberType==="student"&&row.sourcePresent).length],["teacher_memberships",summary.removeTeacherMemberships,allMemberships.filter(row=>row.connectionId===connectionId&&row.memberType==="teacher"&&row.sourcePresent).length]] as const) if(rosterRemovalHeld(removed,previous)) holds.push(`large_removal_${name}`);
  summary.totalSteps=steps.length;
  attachRosterReview(steps, catalogue);
  return {version:1,reviewVersion:1,steps,unresolved,warnings:[...new Set(warnings)],holds,summary,catalogueHash:catalogueRosterHash(catalogue)};
}
