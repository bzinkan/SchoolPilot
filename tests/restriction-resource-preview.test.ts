import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { previewRestrictionResources } from "../src/services/restrictionResourcePreview.js";
import { restrictionResourceRequestNeedsResolution } from "../src/services/restrictionResourceResolver.js";
import { normalizeFlightPathResourcesInput, classroomImportResourceEntries } from "../src/services/classpilotPreciseRestrictions.js";
import { validateClasspilotCommandPayload } from "../src/services/classpilotCommandValidation.js";

const on = { env: {
  CLASSPILOT_PROTOCOL_V3_ENABLED: "true", CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1: "true",
} };
const video = "https://youtu.be/dQw4w9WgXcQ?t=90";
const section = "https://www.nasa.gov/solar-system";

describe("normalized restriction scope previews", () => {
  it("shows a section boundary and website overlap without promising a single page", async () => {
    const preview = await previewRestrictionResources("school-a", {
      purpose: "flight_path", allowedDomains: ["HTTPS://WWW.NASA.GOV/other", "nasa.gov"],
      resources: [{ url: section }, { url: video }],
    }, on);
    assert.deepEqual(preview.authoring.allowedDomains, ["nasa.gov"]);
    assert.deepEqual(preview.scopes.map(scope => scope.type), ["website", "section", "resource"]);
    assert.equal(preview.scopes[1]!.label, "Section");
    assert.match(preview.scopes[1]!.description, /paths below that section/);
    assert.match(preview.warnings[0]!.message, /do not narrow/);
    const saved = await normalizeFlightPathResourcesInput(preview.authoring.resources, "school-a", on);
    assert.deepEqual(saved.resources.map(resource => resource.type), ["section", "resource"]);
    assert.equal(preview.scopes[2]!.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("does not change website-only behavior or require a precise rollout", async () => {
    const preview = await previewRestrictionResources("school-a", {
      purpose: "flight_path", allowedDomains: ["WWW.IXL.COM/science"],
    }, { env: {} });
    assert.deepEqual(preview.authoring, { allowedDomains: ["ixl.com"], resources: [] });
    assert.match(preview.scopes[0]!.description, /Every page/);
    assert.match(preview.warnings[0]!.message, /entire website/);
  });

  it("warns about a broad alternate YouTube host alongside one video", async () => {
    const preview = await previewRestrictionResources("school-a", {
      purpose: "flight_path", allowedDomains: ["youtu.be"], resources: [{ url: video }],
    }, on);
    assert.match(preview.warnings[0]!.message, /do not narrow/);
  });

  it("rejects unsafe/unknown inputs and disabled precise authoring", async () => {
    await assert.rejects(previewRestrictionResources("school-a", {
      purpose: "flight_path", schoolId: "school-b", resources: [],
    }), /request is invalid/);
    await assert.rejects(previewRestrictionResources("school-a", {
      purpose: "flight_path", allowedDomains: ["https://user:secret@example.com"],
    }), /without credentials/);
    await assert.rejects(previewRestrictionResources("school-a", {
      purpose: "flight_path", resources: [{ url: video }],
    }, { env: {} }), /not turned on/);
    await assert.rejects(previewRestrictionResources("school-a", {
      purpose: "flight_path", resources: [{ url: "https://youtube.com/results?search_query=math" }],
    }, on));
  });

  it("previews the same normalized Waypoint including a www section landing", async () => {
    const preview = await previewRestrictionResources("school-a", {
      purpose: "waypoint", boundary: "resource", url: section,
    }, on);
    assert.equal(preview.scopes[0]!.label, "Section");
    assert.equal(preview.scopes[0]!.url, section);
    assert.deepEqual(validateClasspilotCommandPayload("lock-screen", {
      boundary: "resource", url: preview.authoring.url,
    }), validateClasspilotCommandPayload("lock-screen", { boundary: "resource", url: section }));
    const whole = await previewRestrictionResources("school-a", {
      purpose: "waypoint", boundary: "website", url: "https://www.ixl.com/math",
    }, { env: {} });
    assert.equal(whole.scopes[0]!.hostname, "ixl.com");
    assert.equal(whole.authoring.url, "https://www.ixl.com/math");
    await assert.rejects(previewRestrictionResources("school-a", {
      purpose: "waypoint", boundary: "resource", url: "CURRENT_URL",
    }, on), /specific link/);
  });

  it("resolves a Form only through the bounded resolver and counts its rate limit", async () => {
    const request = { purpose: "waypoint", boundary: "resource", url: "https://forms.gle/AbCdEfGhIj" };
    assert.equal(restrictionResourceRequestNeedsResolution(request), true);
    assert.equal(restrictionResourceRequestNeedsResolution({ ...request, boundary: "website" }), false);
    let requests = 0;
    const canonical = "https://docs.google.com/forms/d/abcdefghijklmnopqrstuvwxyz/viewform";
    const preview = await previewRestrictionResources("school-a", request, {
      ...on, fetch: async (url, init) => {
        requests++;
        assert.equal(url, request.url);
        assert.equal(init.redirect, "manual");
        return { status: 302, headers: { get: () => canonical } };
      },
    });
    assert.equal(requests, 1);
    assert.equal(preview.authoring.url, canonical);
    assert.equal(preview.scopes[0]!.label, "Google Form");
  });

  it("makes Classroom boundary selection explicit, reports exclusions and preserves reviewed links", async () => {
    const request = { purpose: "classroom", boundary: "resource", selectedResourceIds: ["a"], resources: [
      { id: "a", links: [{ url: video }, { url: section }, { url: "https://www.youtube.com/results?search_query=math" }] },
      { id: "b", links: [{ url: "https://unselected.example.com" }] },
    ] };
    const preview = await previewRestrictionResources("school-a", request, on);
    assert.deepEqual(preview.scopes.map(scope => scope.type), ["resource", "section"]);
    assert.equal(preview.skipped.length, 1);
    assert.equal(preview.scopes.some(scope => scope.hostname === "unselected.example.com"), false);
    const saved = await classroomImportResourceEntries(preview.authoring.resourceLinks!);
    assert.equal(saved.skipped.length, 0);
    assert.deepEqual(saved.resources.map(resource => resource.type), ["resource", "section"]);
    const broad = await previewRestrictionResources("school-a", { ...request, boundary: "website" }, { env: {} });
    assert.deepEqual(broad.scopes.map(scope => scope.hostname), ["youtu.be", "nasa.gov", "youtube.com"]);
    assert.equal(broad.scopes.every(scope => scope.type === "website"), true);
    await assert.rejects(previewRestrictionResources("school-a", { ...request, selectedResourceIds: ["missing"] }, on), /Every selected/);
  });
});
