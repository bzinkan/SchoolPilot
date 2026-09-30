import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  allowedEntryFromUrl,
  extractAllowedEntries,
} from "../src/routes/classpilot/flightPaths.js";
import {
  classroomImportLinkUrls,
  classroomImportResourceEntries,
} from "../src/services/classpilotPreciseRestrictions.js";

test("Classroom Flight Path imports expose only hostname-level enforcement", async () => {
  assert.equal(
    allowedEntryFromUrl("https://www.youtube.com/watch?v=video-one&t=30"),
    "youtube.com"
  );
  assert.equal(allowedEntryFromUrl("https://youtu.be/video-two"), "youtu.be");
  assert.equal(allowedEntryFromUrl("javascript:alert(1)"), null);
  assert.equal(allowedEntryFromUrl("not a URL/path"), null);

  assert.deepEqual(
    extractAllowedEntries([
      {
        links: [
          { url: "https://www.youtube.com/watch?v=video-one" },
          { url: "https://www.youtube.com/watch?v=video-two" },
          { url: "https://docs.example.edu/lesson/1" },
        ],
      },
    ]),
    ["docs.example.edu", "youtube.com"]
  );

  const source = await readFile(
    new URL("../src/routes/classpilot/flightPaths.ts", import.meta.url),
    "utf8"
  );
  const response = source.slice(
    source.indexOf("return res.status(201).json({", source.indexOf('router.post("/from-classroom"')),
    source.indexOf("// GET /api/classpilot/flight-paths/:id")
  );
  assert.match(response, /domainLevelEntries: allowedDomains/);
  assert.match(response, /enforcementLevel: "hostname"/);
  assert.doesNotMatch(response, /youtubeExactUrls/);
  // Roadmap PR 2: hostname-level import stays the default; resource-level is
  // an explicit boundary that needs the school's precise rollout.
  const route = source.slice(source.indexOf('router.post("/from-classroom"'), source.indexOf("// GET /api/classpilot/flight-paths/:id"));
  assert.match(route, /boundary = "website",/);
  assert.match(route, /if \(boundary === "resource"\) \{\s*requirePreciseRestrictionResourcesActive\(res\.locals\.schoolId!\);/);
  assert.match(response, /enforcementLevel: "resource"/);
});

test("a resource-boundary Classroom import limits each link precisely and never widens one to its host", async () => {
  const urls = classroomImportLinkUrls([
    {
      links: [
        { url: "https://classroom.google.com/c/NjE2MzQ1Njc4/a/NzA4MTIzNDU2/details" },
        { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
        { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
        { url: "https://drive.google.com/file/d/1DriveFileIdAbCdEfGhIjKlMnOpQrSt/view?usp=drive_web" },
        { url: "https://forms.gle/AbCdEf123456" },
        { url: "https://www.ixl.com/math?grade=7" },
        { url: "https://www.youtube.com/@NASA" },
        { url: "https://www.khanacademy.org/" },
      ],
    },
  ], ["https://docs.google.com/document/d/1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ/edit"]);
  assert.equal(urls.length, 8, "duplicate links collapse and fallback links come first");
  const imported = await classroomImportResourceEntries(urls, {
    fetch: async () => ({
      status: 302,
      headers: { get: () => "https://docs.google.com/forms/d/e/1FAIpQLSdPublishedFormIdAbCdEfGhIjKlMnOpQrStUvWx/viewform" },
    }),
  });
  assert.deepEqual(imported.resources.map((entry) => entry.type === "resource" ? `${entry.provider}:${entry.resourceId}` : `section:${entry.hostname}${entry.pathPrefix}`), [
    "google_docs:1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ",
    "section:classroom.google.com/c/NjE2MzQ1Njc4/a/NzA4MTIzNDU2",
    "youtube:dQw4w9WgXcQ",
    "google_drive:1DriveFileIdAbCdEfGhIjKlMnOpQrSt",
    "google_forms:e/1FAIpQLSdPublishedFormIdAbCdEfGhIjKlMnOpQrStUvWx",
  ]);
  assert.deepEqual(imported.websiteHosts, ["khanacademy.org"]);
  assert.deepEqual(imported.skipped.map((entry) => entry.code), ["RESOURCE_URL_UNSUPPORTED", "RESOURCE_URL_UNSUPPORTED"]);
  const unresolved = await classroomImportResourceEntries(["https://forms.gle/AbCdEf123456"], {
    fetch: async () => ({ status: 404, headers: { get: () => null } }),
  });
  assert.deepEqual(unresolved, { resources: [], websiteHosts: [], skipped: [{ url: "https://forms.gle/AbCdEf123456", code: "RESOURCE_SHORT_LINK_UNRESOLVED" }] });
});
