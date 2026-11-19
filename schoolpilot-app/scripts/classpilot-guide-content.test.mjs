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
import { validateGuideReviewEvidence } from "./classpilot-guide-review.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = path.resolve(appRoot, "..", "docs");

const validRoutes = new Set([
  "/classpilot",
  "/classpilot/coverage",
  "/classpilot/my-settings",
  "/classpilot/my-settings/schedule-changes",
  "/classpilot/my-settings?section=appearance",
  "/classpilot/admin",
  "/classpilot/admin?tab=staff",
  "/classpilot/admin/scheduling?section=school-year",
  "/classpilot/coverage?entry=admin",
  "/classpilot/admin?tab=student-portal",
  "/classpilot/admin/analytics",
  "/classpilot/admin/usage",
  "/classpilot/admin/safety",
  "/classpilot/admin/classes",
  "/classpilot/admin/classes/schedule-changes",
  "/classpilot/admin/email-monitoring",
  "/classpilot/admin/it-readiness",
  "/classpilot/roster",
  "/classpilot/settings",
  "/classpilot/settings?section=school",
  "/classpilot/settings?section=appearance",
  "/classpilot/settings?section=browsing",
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
  // Existing topic links and search aliases stay stable; rendered guidance
  // must not direct a teacher back to the retired controls.
  assert.doesNotMatch(teacherGuideMarkdown, /\bWaypoints?\b|Open \+ Focus|Focus current tab|Stop Both/i);
});

test("administrator guide preserves entitlement and policy boundaries without retired terminology", () => {
  const emailTopic = adminGuideTopics.find((topic) => topic.id === "email-monitoring");
  assert.equal(emailTopic?.entitlement, "mailpilot");
  const signInTopic = adminGuideTopics.find((topic) => topic.id === "student-sign-in-policy");
  assert.equal(signInTopic?.route, "/classpilot/admin?tab=student-portal");
  const workspaceTopic = adminGuideTopics.find((topic) => topic.id === "google-workspace-policies");
  assert.equal(workspaceTopic?.phase, "Policies");
  assert.match(contentText([workspaceTopic]), /force[ -]install/i);
  assert.match(contentText([workspaceTopic]), /cannot read Google Admin policy state/);
  const adminIds = adminGuideTopics.map((topic) => topic.id);
  assert.equal(adminIds[adminIds.indexOf("school-settings") + 1], "google-workspace-policies", "Workspace policy topic must follow school settings");
  assert.doesNotMatch(contentText(adminGuideTopics), forbiddenGuideTerms);
  assert.doesNotMatch(adminGuideMarkdown, /\bWaypoints?\b/i);
});

test("released supervision and roster recovery guidance cannot regress to retired instructions", () => {
  const supervision = [
    teacherGuideTopics.find(topic => topic.id === "coverage-workflow"),
    adminGuideTopics.find(topic => topic.id === "coverage-administration"),
  ];
  for (const topic of supervision) {
    assert.match(contentText([topic]), /My room/);
    assert.doesNotMatch(contentText([topic]), /opens neutral Claimed|creates or reuses your neutral|Direct sessions and personal claims are not Send destinations|next scheduled handoff returns to Class/);
  }
  const recovery = teacherGuideTopics.find(topic => topic.id === "start-and-resync");
  assert.match(contentText([recovery]), /Refresh class/);
  assert.match(contentText([recovery]), /frozen/i);
  assert.doesNotMatch(teacherGuideMarkdown, /coverage has a smaller tool set|My templates|Questions for later|Advance every step yourself/);
});

test("Workspace setup distinguishes roster delegation from personal Classroom OAuth", () => {
  const connector = adminGuideTopics.find(topic => topic.id === "workspace-roster-connector");
  assert.equal(connector?.phase, "Launch");
  assert.equal(connector?.route, "/classpilot/admin/it-readiness");
  assert.match(contentText([connector]), /domain.wide delegation/i);
  assert.match(contentText([connector]), /Verify/);
  assert.match(contentText([connector]), /Classroom/);
  assert.doesNotMatch(adminGuideMarkdown, /Roster manages class membership|AI detection itself never closes tabs|AI detections leave tabs open/);
});

test("guide entry instructions follow the current menus", () => {
  assert.match(guideIndexMarkdown, /Teaching tools.*Teacher guide/);
  assert.match(guideIndexMarkdown, /Help.*Admin guide/);
  assert.doesNotMatch(guideIndexMarkdown, /Admin Settings → Admin Guide/);
});

test("every topic has reviewed sources and checks without implying production verification", async () => {
  const scriptsRoot = path.join(appRoot, "scripts");
  const [teacher, admin, baseline] = await Promise.all([
    readFile(path.join(scriptsRoot, "classpilot-guide-teacher-evidence.json"), "utf8").then(JSON.parse),
    readFile(path.join(scriptsRoot, "classpilot-guide-admin-evidence.json"), "utf8").then(JSON.parse),
    readFile(path.join(scriptsRoot, "classpilot-guide-release-baseline.json"), "utf8").then(JSON.parse),
  ]);
  await validateGuideReviewEvidence({ repositoryRoot: path.resolve(appRoot, ".."),
    topicsByGuide: { teacher: teacherGuideTopics, admin: adminGuideTopics }, reviews: { teacher, admin } });
  assert.equal(baseline.schemaVersion, 1);
  assert.match(baseline.sourceSha, /^[a-f0-9]{40}$/);
  assert.equal(baseline.worker.sourceSha, baseline.sourceSha);
  assert.equal(baseline.api.imageDigest, baseline.worker.imageDigest);
  if (baseline.frontend.basis === "served-guide-content-compared") {
    assert.equal(baseline.frontend.sourceSha, null, "asset comparison must not invent whole-frontend source identity");
  }
  assert.ok(["unverified", "live-observed"].includes(baseline.extension.basis), "Store publication alone cannot establish adoption");
});

test("generated Markdown exports exactly match the canonical in-app source", async () => {
  const [index, teacher, admin] = await Promise.all([
    readFile(path.join(docsRoot, "CLASSPILOT_USER_GUIDE.md"), "utf8"),
    readFile(path.join(docsRoot, "CLASSPILOT_TEACHER_GUIDE.md"), "utf8"),
    readFile(path.join(docsRoot, "CLASSPILOT_ADMIN_GUIDE.md"), "utf8"),
  ]);
  // Git may check generated Markdown out as CRLF on Windows. Preserve exact
  // content equality while allowing that platform-only line-ending conversion.
  assert.equal(index.replace(/\r\n/g, "\n"), guideIndexMarkdown);
  assert.equal(teacher.replace(/\r\n/g, "\n"), teacherGuideMarkdown);
  assert.equal(admin.replace(/\r\n/g, "\n"), adminGuideMarkdown);
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
  assert.match(settingsSource, /if \(!currentUser \|\| !currentUser.schoolId \|\| !\(isAdmin \|\| currentUser.isSuperAdmin\)\) return <Navigate/);
  assert.match(settingsSource, /return <SettingsWorkspace key=\{scope\}/, "only authorized identities mount the querying workspace");
  assert.doesNotMatch(settingsSource, /POST.*['"]\/settings['"]/, "admin edits must use scoped section APIs");
});
