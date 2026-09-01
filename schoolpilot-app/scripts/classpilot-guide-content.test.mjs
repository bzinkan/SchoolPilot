import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  adminGuideMarkdown,
  guideIndexMarkdown,
  teacherGuideMarkdown,
} from "./classpilot-guide-markdown.mjs";
import { teacherGuidePhases, teacherGuideTopics } from "../src/products/classpilot/guides/teacherGuideContent.js";
import { adminGuidePhases, adminGuideTopics } from "../src/products/classpilot/guides/adminGuideContent.js";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = path.resolve(appRoot, "..", "docs");

const validRoutes = new Set([
  "/classpilot",
  "/classpilot/coverage",
  "/classpilot/my-settings",
  "/classpilot/my-settings/schedule-changes",
  "/classpilot/admin",
  "/classpilot/admin/analytics",
  "/classpilot/admin/classes",
  "/classpilot/admin/classes/schedule-changes",
  "/classpilot/admin/email-monitoring",
  "/classpilot/admin/it-readiness",
  "/classpilot/roster",
  "/classpilot/settings",
  "/classpilot/students",
]);

const forbiddenGuideTerms = /live[ -]view|interactive streaming|camera monitoring|ip allowlist|manual device assignment|\bscenes?\b/i;

function contentText(topics) {
  return topics.map((topic) => JSON.stringify(topic)).join("\n");
}

function validateGuide(phases, topics) {
  const ids = topics.map((topic) => topic.id);
  assert.equal(new Set(ids).size, ids.length, "guide topic IDs must be unique");
  for (const topic of topics) {
    assert.match(topic.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `invalid topic id: ${topic.id}`);
    assert.ok(phases.includes(topic.phase), `unknown phase for ${topic.id}`);
    assert.ok(topic.keywords?.length > 0, `missing keywords for ${topic.id}`);
    assert.ok(topic.steps?.length > 0, `missing ordered steps for ${topic.id}`);
    assert.ok(topic.role, `missing role requirement for ${topic.id}`);
    assert.ok(validRoutes.has(topic.route), `invalid internal route for ${topic.id}: ${topic.route}`);
  }
}

test("guide content has stable IDs, searchable structure, roles, and valid application routes", () => {
  validateGuide(teacherGuidePhases, teacherGuideTopics);
  validateGuide(adminGuidePhases, adminGuideTopics);
});

test("teacher guide contains no administrator routes or retired terminology", () => {
  assert.equal(teacherGuideTopics.some((topic) => topic.route === "/classpilot/settings" || topic.route.startsWith("/classpilot/admin")), false);
  assert.doesNotMatch(contentText(teacherGuideTopics), forbiddenGuideTerms);
});

test("administrator guide covers entitlement and restricted sign-in policy without retired terminology", () => {
  const emailTopic = adminGuideTopics.find((topic) => topic.id === "email-monitoring");
  assert.equal(emailTopic?.entitlement, "mailpilot");
  const signInTopic = adminGuideTopics.find((topic) => topic.id === "student-sign-in-policy");
  assert.match(contentText([signInTopic]), /restrictionAuthPassThroughV1/);
  assert.match(contentText([signInTopic]), /five-minute attempt/);
  assert.doesNotMatch(contentText(adminGuideTopics), forbiddenGuideTerms);
});

test("generated Markdown exports exactly match the canonical in-app source", async () => {
  const [index, teacher, admin] = await Promise.all([
    readFile(path.join(docsRoot, "CLASSPILOT_USER_GUIDE.md"), "utf8"),
    readFile(path.join(docsRoot, "CLASSPILOT_TEACHER_GUIDE.md"), "utf8"),
    readFile(path.join(docsRoot, "CLASSPILOT_ADMIN_GUIDE.md"), "utf8"),
  ]);
  assert.equal(index, guideIndexMarkdown);
  assert.equal(teacher, teacherGuideMarkdown);
  assert.equal(admin, adminGuideMarkdown);
});

test("router source fail-closes admin settings and exposes both lazy guide routes", async () => {
  const [appSource, settingsSource] = await Promise.all([
    readFile(path.join(appRoot, "src", "App.jsx"), "utf8"),
    readFile(path.join(appRoot, "src", "products", "classpilot", "pages", "Settings.jsx"), "utf8"),
  ]);
  assert.match(appSource, /canManageClassPilotSchool && <Route path="\/classpilot\/settings"/);
  assert.match(appSource, /canManageClassPilotSchool && <Route path="\/classpilot\/settings\/guide"/);
  assert.match(appSource, /canReadClassPilotTeacherGuide && <Route path="\/classpilot\/my-settings\/guide"/);
  assert.match(appSource, /lazy\(\(\) => import\('\.\/products\/classpilot\/pages\/TeacherGuide'\)\)/);
  assert.match(appSource, /lazy\(\(\) => import\('\.\/products\/classpilot\/pages\/AdminGuide'\)\)/);
  assert.match(settingsSource, /if \(!canManageSchoolSettings\) \{\s*return <Navigate to="\/classpilot" replace \/>/);
  assert.equal((settingsSource.match(/useQuery\(\{/g) || []).length, 6, "unexpected Admin Settings query inventory");
  assert.equal((settingsSource.match(/enabled: canManageSchoolSettings/g) || []).length, 6, "every Admin Settings query must wait for admin authority");
});
