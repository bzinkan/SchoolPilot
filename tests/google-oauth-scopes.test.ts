import test from "node:test";
import assert from "node:assert/strict";
import {
  CLASSROOM_COURSES_SCOPE,
  CLASSROOM_RESOURCE_SCOPES,
  missingGoogleOAuthScopes,
} from "../src/util/googleOAuthScopes.js";

const coursework = "https://www.googleapis.com/auth/classroom.coursework.students.readonly";
const courseworkAlias = "https://www.googleapis.com/auth/classroom.student-submissions.students.readonly";
const materials = "https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly";
const emailAlias = "https://www.googleapis.com/auth/userinfo.email";

test("the Google-returned teacher grant permits resources and reports no missing connection scopes", () => {
  // Shape of the actual grant whose courseWork.list succeeded while the
  // resource endpoint incorrectly returned MISSING_GOOGLE_SCOPE.
  const grant = [CLASSROOM_COURSES_SCOPE, materials, courseworkAlias, emailAlias, "openid"].join(" ");
  assert.deepEqual(missingGoogleOAuthScopes(grant, CLASSROOM_RESOURCE_SCOPES), []);
  assert.deepEqual(missingGoogleOAuthScopes(grant, ["openid", "email", ...CLASSROOM_RESOURCE_SCOPES]), []);
});

test("the originally requested scope strings remain valid", () => {
  const required = ["openid", "email", ...CLASSROOM_RESOURCE_SCOPES];
  assert.deepEqual(missingGoogleOAuthScopes(required.join(" "), required), []);
  assert.deepEqual(missingGoogleOAuthScopes(coursework, [courseworkAlias]), []);
  assert.deepEqual(missingGoogleOAuthScopes("email", [emailAlias]), []);
});

test("a courses-only grant still requires assignment and material permissions", () => {
  assert.deepEqual(missingGoogleOAuthScopes(CLASSROOM_COURSES_SCOPE, CLASSROOM_RESOURCE_SCOPES), [coursework, materials]);
  assert.deepEqual(missingGoogleOAuthScopes(courseworkAlias, CLASSROOM_RESOURCE_SCOPES), [CLASSROOM_COURSES_SCOPE, materials]);
});

test("student-only, write, unrelated, and lookalike scope strings are not treated as teacher read aliases", () => {
  for (const grant of [
    "https://www.googleapis.com/auth/classroom.student-submissions.me.readonly",
    "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
    "https://www.googleapis.com/auth/classroom.coursework.students",
    `${courseworkAlias}.extra`,
    "https://example.com/auth/classroom.student-submissions.students.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
  ]) {
    assert.deepEqual(missingGoogleOAuthScopes(grant, [coursework]), [coursework]);
  }
});

test("missing grants and missing unrelated permissions continue to fail closed", () => {
  for (const grant of [undefined, null, "", " \t\n "]) {
    assert.deepEqual(missingGoogleOAuthScopes(grant, CLASSROOM_RESOURCE_SCOPES), [...CLASSROOM_RESOURCE_SCOPES]);
  }
  assert.deepEqual(missingGoogleOAuthScopes(courseworkAlias, ["https://www.googleapis.com/auth/admin.directory.user.readonly"]), ["https://www.googleapis.com/auth/admin.directory.user.readonly"]);
});

test("whitespace, duplicate scopes, and mixed canonical names do not change the result", () => {
  const grant = `\t${courseworkAlias}\n${CLASSROOM_COURSES_SCOPE}  ${materials}\r\n${coursework} ${courseworkAlias} `;
  assert.deepEqual(missingGoogleOAuthScopes(grant, CLASSROOM_RESOURCE_SCOPES), []);
});
