import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  allowedEntryFromUrl,
  extractAllowedEntries,
} from "../src/routes/classpilot/flightPaths.js";

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
});
