import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  CLASSPILOT_ACTIVITY_KINDS,
  CLASSPILOT_ACTIVITY_LABELS,
  classifyClasspilotActivity,
  classpilotActivityLabel,
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
    ["https://mail.google.com/mail/u/0/#inbox", "google_mail", "mail.google.com"],
    ["https://meet.google.com/abc-defg-hij", "google_meet", "meet.google.com"],
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
    "google_search",
    "google_mail",
    "google_meet",
    "google_workspace_unspecified",
  ]);
});

test("ClassPilot activity attribution resolves google.com by path without keeping the query", () => {
  // The reason this feature exists: "google.com" told a teacher nothing.
  assert.deepEqual(classifyClasspilotActivity("https://www.google.com/search?q=student-secret"), {
    kind: "google_search",
    domain: "google.com",
  });
  assert.deepEqual(classifyClasspilotActivity("https://google.com/"), {
    kind: "google_search",
    domain: "google.com",
  });
  assert.deepEqual(classifyClasspilotActivity("https://www.google.com"), {
    kind: "google_search",
    domain: "google.com",
  });

  // An unrecognized google.com path is not claimed as Search. Naming the wrong
  // app is worse than naming none.
  assert.deepEqual(classifyClasspilotActivity("https://www.google.com/maps/place/private"), {
    kind: "domain",
    domain: "google.com",
  });

  // Lookalikes still fall through to a plain domain.
  assert.deepEqual(classifyClasspilotActivity("https://google.com.evil.example/search?q=x"), {
    kind: "domain",
    domain: "google.com.evil.example",
  });

  // The kind is literally named "google_search", so the meaningful assertion is
  // that no part of the query, path or fragment survives -- not that the word
  // "search" is absent.
  const serialized = JSON.stringify(classifyClasspilotActivity(
    "https://www.google.com/search?q=student-secret&client=chrome#top"
  ));
  assert.deepEqual(JSON.parse(serialized), { kind: "google_search", domain: "google.com" });
  assert.equal(serialized.includes("student-secret"), false);
  assert.equal(serialized.includes("q="), false);
  assert.equal(serialized.includes("client=chrome"), false);
  assert.equal(serialized.includes("top"), false);
  assert.equal(serialized.includes("/search"), false);
});

test("ClassPilot activity labels stay in step between the server and the Student Data UI", async () => {
  // The label map is necessarily duplicated across the TS backend and the JSX
  // bundle. This is what keeps the pair honest: an unenforced copy drifts, and
  // the email would then name an app differently from the in-app screen.
  const frontendSource = await readFile(
    new URL(
      "../schoolpilot-app/src/products/classpilot/lib/studentData.js",
      import.meta.url
    ),
    "utf8"
  );

  const labelBlock = frontendSource.match(
    /const STUDENT_DATA_ACTIVITY_LABELS = Object\.freeze\(\{([\s\S]*?)\}\);/
  );
  assert.ok(labelBlock, "STUDENT_DATA_ACTIVITY_LABELS not found in studentData.js");
  const frontendLabels = new Map<string, string>();
  for (const match of labelBlock[1]!.matchAll(/(\w+):\s*'([^']*)'/g)) {
    const [, key, value] = match;
    if (typeof key === "string" && typeof value === "string") frontendLabels.set(key, value);
  }

  assert.deepEqual(
    Object.entries(CLASSPILOT_ACTIVITY_LABELS).sort(),
    [...frontendLabels.entries()].sort(),
    "backend CLASSPILOT_ACTIVITY_LABELS and frontend STUDENT_DATA_ACTIVITY_LABELS disagree"
  );

  // `domain` must stay unlabelled on both sides: it is how a plain website
  // renders as its own hostname.
  assert.equal(Object.hasOwn(CLASSPILOT_ACTIVITY_LABELS, "domain"), false);
  assert.equal(frontendLabels.has("domain"), false);

  const kindBlock = frontendSource.match(
    /const STUDENT_DATA_ACTIVITY_KINDS = new Set\(\[([\s\S]*?)\]\);/
  );
  assert.ok(kindBlock, "STUDENT_DATA_ACTIVITY_KINDS not found in studentData.js");
  const frontendKinds = [...kindBlock[1]!.matchAll(/'([^']+)'/g)]
    .map((match) => match[1])
    .filter((kind): kind is string => typeof kind === "string");
  assert.deepEqual(
    frontendKinds,
    [...CLASSPILOT_ACTIVITY_KINDS],
    "backend CLASSPILOT_ACTIVITY_KINDS and frontend STUDENT_DATA_ACTIVITY_KINDS disagree"
  );
});

test("ClassPilot activity labels name the app, and plain sites stay hostnames", () => {
  assert.equal(
    classpilotActivityLabel({ kind: "google_search", domain: "google.com" }),
    "Google Search"
  );
  assert.equal(
    classpilotActivityLabel({ kind: "google_docs", domain: "docs.google.com" }),
    "Google Docs"
  );
  assert.equal(classpilotActivityLabel({ kind: "google_mail", domain: "mail.google.com" }), "Gmail");
  assert.equal(classpilotActivityLabel({ kind: "domain", domain: "ixl.com" }), "ixl.com");
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
