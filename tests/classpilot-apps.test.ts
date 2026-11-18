import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commonClasspilotApps,
  normalizeAppWebsite,
  appButtonInput,
  appButtonPreferenceInput,
  appButtonView,
} from "../src/services/classpilotApps.js";

const classroomDomains = ["classroom.google.com", "docs.google.com", "drive.google.com",
  "sheets.google.com", "slides.google.com", "forms.google.com", "forms.gle"];

describe("ClassPilot app definitions", () => {
  it("offers a bounded Classroom bundle and individual Google launchers", () => {
    assert.equal(commonClasspilotApps.length, 9);
    const bundle = commonClasspilotApps.find(app => app.key === "builtin:classroom-bundle")!;
    assert.equal(bundle.kind, "bundle");
    assert.equal(bundle.launchUrl, null);
    assert.deepEqual(bundle.allowedDomains, classroomDomains);
    const classroom = commonClasspilotApps.find(app => app.key === "builtin:classroom")!;
    assert.deepEqual(classroom.allowedDomains, ["classroom.google.com"]);
    assert.deepEqual(classroom.effectiveAllowedDomains, classroomDomains);
    assert.equal(bundle.includedApps?.length, 6);
    for (const [key, path] of [["docs", "document"], ["slides", "presentation"], ["sheets", "spreadsheets"], ["forms", "forms"]]) {
      const app = commonClasspilotApps.find(app => app.key === `builtin:${key}`)!;
      assert.equal(app.launchUrl, `https://docs.google.com/${path}/`);
      assert.deepEqual(app.allowedDomains, ["docs.google.com"]);
    }
    assert.equal(commonClasspilotApps.some(app => app.allowedDomains.includes("google.com")), false);
  });

  it("normalizes a website once while retaining its exact launch path", () => {
    assert.deepEqual(normalizeAppWebsite("  WWW.Example.edu/math?lesson=3  "), {
      launchUrl: "https://www.example.edu/math?lesson=3", allowedDomains: ["example.edu"],
    });
    assert.deepEqual(normalizeAppWebsite("https://classroom.google.com/c/class-123"), {
      launchUrl: "https://classroom.google.com/c/class-123", allowedDomains: ["classroom.google.com"],
    });
    const classroom = appButtonView({ id: "classroom", schoolId: "school-1", ownerTeacherId: "teacher-1", scope: "personal", name: "Classroom", launchUrl: "https://classroom.google.com/c/class-123", revision: 1 },
      null, { teacherId: "teacher-1", isAdmin: false });
    assert.deepEqual(classroom.allowedDomains, ["classroom.google.com"]);
    assert.deepEqual(classroom.effectiveAllowedDomains, classroomDomains);
  });

  it("rejects credentialed, non-web, wildcard, local and public-suffix addresses", () => {
    for (const url of ["javascript:alert(1)", "file:///local", "https://a:b@example.edu", "https://*.example.edu", "http://127.0.0.1", "localhost", "https://com", "https://co.uk"]) {
      assert.throws(() => normalizeAppWebsite(url), { name: "ZodError" }, url);
    }
  });

  it("accepts only website fields and consistent personal preferences", () => {
    assert.deepEqual(appButtonInput.parse({ scope: "personal", name: " Math ", launchUrl: "ixl.com" }), {
      scope: "personal", name: "Math", launchUrl: "ixl.com",
    });
    assert.equal(appButtonInput.safeParse({ scope: "personal", name: "X", launchUrl: "ixl.com", schoolId: "another" }).success, false);
    assert.equal(appButtonPreferenceInput.safeParse({ saved: false, favorite: true }).success, false);
    assert.equal(appButtonPreferenceInput.safeParse({ saved: true, favorite: true }).success, true);
  });

  it("bounds the normalized URL including escaped characters and added scheme", () => {
    assert.throws(() => normalizeAppWebsite(`example.edu/${"x".repeat(4_090)}`));
    assert.throws(() => normalizeAppWebsite(`https://example.edu/${"é".repeat(1_000)}`));
  });

  it("projects custom entries without school or owner identifiers", () => {
    const view = appButtonView({ id: "button-1", schoolId: "school-1", ownerTeacherId: "teacher-1", scope: "personal", name: "Math", launchUrl: "https://www.ixl.com/", revision: 1 },
      { saved: true, favorite: true }, { teacherId: "teacher-1", isAdmin: false });
    assert.deepEqual(view, { key: "saved:button-1", kind: "app", source: "personal", name: "Math", launchUrl: "https://www.ixl.com/", allowedDomains: ["ixl.com"], iconKey: "website", saved: true, favorite: true, canEdit: true, revision: 1 });
    assert.equal(appButtonView({ id: "school-app", schoolId: "school-1", ownerTeacherId: null, scope: "school", name: "Math", launchUrl: "https://www.ixl.com/", revision: 1 }, null,
      { teacherId: "teacher-1", isAdmin: false }).canEdit, false);
  });
});
