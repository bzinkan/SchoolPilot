import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

const TEACHER_ME = /teacherId:\s*["']me["']/;
const SHARED_CAPPED_LISTING = /listClassroomCourses\(classroom, \{\s*maxCourses: CLASSROOM_COURSE_PREVIEW_LIMIT,?\s*\}\)/;

test("delegated-admin Classroom listings never filter by teacherId \"me\"", async () => {
  const [adminClasses, compat, classroom, connector, students] = await Promise.all([
    source("src/routes/classpilot/adminClasses.ts"),
    source("src/routes/compat.ts"),
    source("src/routes/google/classroom.ts"),
    source("src/services/googleRosterConnector.ts"),
    source("src/routes/students.ts"),
  ]);

  // The connector client impersonates the delegated admin; "me" there hides
  // every course the admin does not personally teach.
  assert.doesNotMatch(adminClasses, TEACHER_ME);
  assert.doesNotMatch(compat, TEACHER_ME);
  for (const routeSource of [adminClasses, compat, classroom]) {
    assert.doesNotMatch(routeSource, /courses\.list\(/, "course listings must go through listClassroomCourses");
  }
  assert.match(adminClasses, SHARED_CAPPED_LISTING);
  assert.match(compat, SHARED_CAPPED_LISTING);
  assert.match(compat, /getRosterClassroomClientForSchool\(res\.locals\.schoolId!\)/);
  assert.match(compat, /return res\.json\(\{ courses, truncated \}\)/);

  // google/classroom.ts GET /courses: "me" is correct only on the caller's own
  // OAuth client (purpose=classroom_resources); the connector branch lists the
  // whole domain with the preview cap.
  const routeStart = classroom.indexOf('router.get("/courses", ...staffAuth');
  assert.ok(routeStart >= 0, "GET /courses route anchor missing");
  const branchStart = classroom.indexOf("if (useResourceOAuth) {", routeStart);
  const branchEnd = classroom.indexOf("} else {", branchStart);
  assert.ok(branchStart > routeStart && branchEnd > branchStart, "useResourceOAuth branch anchors missing");
  const oauthBranch = classroom.slice(branchStart, branchEnd);
  assert.match(oauthBranch, /listClassroomCourses\(classroom, \{ teacherId: "me" \}\)/);
  assert.doesNotMatch(classroom.slice(0, branchStart), TEACHER_ME);
  assert.doesNotMatch(classroom.slice(branchEnd), TEACHER_ME);
  const connectorBranch = classroom.slice(branchEnd, classroom.indexOf("const savedCourses", branchEnd));
  assert.match(connectorBranch, /getRosterClassroomClientForSchool\(schoolId\)/);
  assert.match(connectorBranch, SHARED_CAPPED_LISTING);
  assert.match(classroom, /truncated: listing\.truncated/);

  // The helpers are re-exported next to the classroom client factory and the
  // pure module stays free of storage/DB imports.
  const helpers = await source("src/services/googleClassroomCourses.ts");
  assert.doesNotMatch(helpers, /from "\.\/storage\.js"|from "\.\.\/db\.js"|drizzle-orm|googleapis/);
  const factoryIndex = connector.indexOf("export async function getRosterClassroomClientForSchool");
  const reExportIndex = connector.indexOf('} from "./googleClassroomCourses.js";');
  assert.ok(factoryIndex >= 0 && reExportIndex > factoryIndex, "re-export must follow getRosterClassroomClientForSchool");
  for (const name of [
    "CLASSROOM_COURSE_PREVIEW_LIMIT",
    "CLASSROOM_FANOUT_CONCURRENCY",
    "classroomCourseStaffFromTeachers",
    "listClassroomCourseTeachers",
    "listClassroomCourses",
  ]) {
    assert.ok(connector.slice(factoryIndex, reExportIndex).includes(name), `${name} re-export missing`);
  }

  // mapWithConcurrency now lives in src/util/concurrency.ts.
  assert.match(students, /import \{ mapWithConcurrency \} from "\.\.\/util\/concurrency\.js"/);
  assert.doesNotMatch(students, /async function mapWithConcurrency/);
  assert.match(adminClasses, /import \{ mapWithConcurrency \} from "\.\.\/\.\.\/util\/concurrency\.js"/);
});

test("Classroom import preview matches the existing class or the Classroom owner, never the importing admin", async () => {
  const adminClasses = await source("src/routes/classpilot/adminClasses.ts");

  const previewStart = adminClasses.indexOf('router.get("/classroom/import-preview", ...auth');
  const importStart = adminClasses.indexOf('router.post("/classroom/import", ...auth');
  const createStart = adminClasses.indexOf('router.post("/", ...auth');
  assert.ok(previewStart >= 0 && importStart > previewStart && createStart > importStart, "route order changed");
  const preview = adminClasses.slice(previewStart, importStart);
  const importRoute = adminClasses.slice(importStart, createStart);

  assert.match(preview, /importability: existingClass \? "update" : matchedTeacher \? "ready" : "needs_teacher"/);
  assert.match(preview, /const matchedTeacher = existingPrimary \?\? staff\.owner/);
  assert.match(preview, /matchSource = existingPrimary \? "existing_class" : staff\.owner \? "classroom_owner" : null/);
  assert.match(preview, /ownerEmail: staff\.ownerEmail/);
  assert.match(preview, /suggestedCoTeachers: staff\.coTeachers/);
  assert.match(preview, /mapWithConcurrency\(courses, CLASSROOM_FANOUT_CONCURRENCY/);
  assert.match(preview, /truncated, limit: CLASSROOM_COURSE_PREVIEW_LIMIT/);

  for (const [label, slice] of [["preview", preview], ["import", importRoute]] as const) {
    assert.doesNotMatch(slice, /validateTeachableUser\(req\.authUser!\.id/, `${label} must not default to the calling admin`);
    assert.doesNotMatch(slice, /defaultTeacher/, `${label} must not carry a default teacher`);
    assert.match(slice, /teacherResolver\(schoolId\)/, `${label} resolves Classroom emails through the request-scoped resolver`);
  }
  assert.match(importRoute, /selected\.primaryTeacherId \|\| existingClass\?\.teacherId \|\| ""/);
  assert.match(importRoute, /resolveCourseStaff\(/);
  assert.match(importRoute, /"TEACHER_REQUIRED"/);
  assert.match(importRoute, /requestedCoTeacherIds === undefined \? preservedCoTeachers : requestedCoTeacherIds/);

  // The resolver is the only place the owner email becomes a SchoolPilot user,
  // and it goes through the same teachable-role check as manual assignment.
  const resolverStart = adminClasses.indexOf("function teacherResolver(schoolId: string)");
  const resolverEnd = adminClasses.indexOf("type TeacherResolver", resolverStart);
  assert.ok(resolverStart >= 0 && resolverEnd > resolverStart);
  const resolver = adminClasses.slice(resolverStart, resolverEnd);
  assert.match(resolver, /getUserByEmail\(emailLc\)/);
  assert.match(resolver, /validateTeachableUser\(user\.id, schoolId\)/);
  assert.match(resolver, /IdentityEmailConflictError/);

  // Route-level guards that other suites also pin.
  assert.equal(adminClasses.indexOf('router.post("/", ...auth'), createStart);
  assert.match(adminClasses, /process\.env\.CLASSPILOT_CLASSROOM_IMPORT_ENABLED !== "false"/);
});

test("Classroom import gates default on and are documented", async () => {
  const [env, page] = await Promise.all([
    source(".env.example"),
    source("schoolpilot-app/src/products/classpilot/pages/AdminClasses.jsx"),
  ]);

  assert.match(env, /^CLASSPILOT_CLASSROOM_IMPORT_ENABLED=/m);
  assert.match(env, /^VITE_CLASSPILOT_CLASSROOM_IMPORT_ENABLED=/m);
  assert.match(env, /super admin/);

  assert.match(page, /import\.meta\.env\.VITE_CLASSPILOT_CLASSROOM_IMPORT_ENABLED !== "false"/);
  assert.match(page, /previewQuery\.data\?\.truncated/);
  assert.match(page, /Showing the first \{previewLimit\} active courses/);
  assert.match(page, /no teachable SchoolPilot account/);
  assert.match(page, /from Classroom owner/);
  assert.match(page, /Confirm it is a Google Workspace super admin/);
  assert.match(page, /keepSuggestedCoTeachers \? \{ coTeacherIds \} : \{\}/);
  // Pinned by schoolpilot-app/scripts/staff-identity-contracts.test.mjs.
  assert.match(page, /` — \$\{teacher\.email\}`/);
});
