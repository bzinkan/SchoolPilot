import assert from "node:assert/strict";
import test from "node:test";
import {
  CLASSPILOT_ACTIVITY_KINDS,
  classifyClasspilotActivity,
} from "../src/services/classpilotActivityAttribution.js";

test("ClassPilot activity attribution recognizes exact Google Workspace URL shapes", () => {
  const cases = [
    ["https://docs.google.com/document/d/private-document-id/edit?tab=t.0#heading", "google_docs", "docs.google.com"],
    ["https://docs.google.com/presentation/d/private-slides-id/edit", "google_slides", "docs.google.com"],
    ["https://docs.google.com/forms/d/private-form-id/viewform", "google_forms", "docs.google.com"],
    ["https://docs.google.com/spreadsheets/d/private-sheet-id/edit", "google_sheets", "docs.google.com"],
    ["https://slides.google.com/example", "google_slides", "slides.google.com"],
    ["https://forms.google.com/example", "google_forms", "forms.google.com"],
    ["https://sheets.google.com/example", "google_sheets", "sheets.google.com"],
    ["https://spreadsheets.google.com/example", "google_sheets", "spreadsheets.google.com"],
    ["https://classroom.google.com/u/0/h", "google_classroom", "classroom.google.com"],
    ["https://drive.google.com/drive/my-drive", "google_drive", "drive.google.com"],
  ] as const;

  for (const [url, kind, domain] of cases) {
    assert.deepEqual(classifyClasspilotActivity(url), { kind, domain });
  }
  assert.deepEqual(CLASSPILOT_ACTIVITY_KINDS, [
    "domain",
    "google_docs",
    "google_slides",
    "google_forms",
    "google_sheets",
    "google_classroom",
    "google_drive",
    "google_workspace_unspecified",
  ]);
});

test("ClassPilot activity attribution is exact-host, exact-path, and privacy safe", () => {
  assert.deepEqual(classifyClasspilotActivity("https://docs.google.com/"), {
    kind: "google_workspace_unspecified",
    domain: "docs.google.com",
  });
  assert.deepEqual(classifyClasspilotActivity("https://docs.google.com/documentation/private"), {
    kind: "google_workspace_unspecified",
    domain: "docs.google.com",
  });
  assert.deepEqual(classifyClasspilotActivity("https://docs.google.com.evil.example/document/private"), {
    kind: "domain",
    domain: "docs.google.com.evil.example",
  });
  assert.deepEqual(classifyClasspilotActivity("https://drive.google.com.evil.example/private"), {
    kind: "domain",
    domain: "drive.google.com.evil.example",
  });
  assert.deepEqual(classifyClasspilotActivity("https://www.example.edu/private/path?q=student-secret#answer"), {
    kind: "domain",
    domain: "example.edu",
  });
  assert.equal(classifyClasspilotActivity("chrome://settings"), null);
  assert.equal(classifyClasspilotActivity("not a URL"), null);

  const serialized = JSON.stringify(classifyClasspilotActivity(
    "https://docs.google.com/document/d/private-document-id/edit?q=student-secret#answer"
  ));
  assert.equal(serialized.includes("private-document-id"), false);
  assert.equal(serialized.includes("student-secret"), false);
  assert.equal(serialized.includes("document/d"), false);
});
