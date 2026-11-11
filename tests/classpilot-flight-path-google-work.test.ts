import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classpilotFlightPathApplyPayload,
  withFlightPathResourcesVisibility,
} from "../src/services/classpilotPreciseRestrictions.js";
import { previewRestrictionResources } from "../src/services/restrictionResourcePreview.js";

const companions = ["docs.google.com", "drive.google.com", "sheets.google.com", "slides.google.com", "forms.google.com", "forms.gle"];
const env = { CLASSPILOT_PROTOCOL_V3_ENABLED: "true", CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1: "true" };
function payload(allowedDomains: string[], resources: unknown[] = []) {
  return classpilotFlightPathApplyPayload({ schoolId: "fixture", env,
    flightPath: { id: "path", flightPathName: "Work", allowedDomains, resources } });
}

test("Classroom application includes Google work without changing saved domains or the landing order", () => {
  const domains = ["ixl.com", "classroom.google.com"];
  assert.deepEqual(payload(domains).allowedDomains, [...domains, ...companions]);
  assert.deepEqual(domains, ["ixl.com", "classroom.google.com"]);
  assert.deepEqual(payload(["classroom.google.com", "docs.google.com"]).allowedDomains,
    ["classroom.google.com", ...companions]);
});

test("only an exact normalized Classroom website activates the bundle", () => {
  for (const website of [" CLASSROOM.GOOGLE.COM ", "https://www.classroom.google.com./c/123"]) {
    assert.deepEqual(payload([website]).allowedDomains, [website, ...companions]);
  }
  for (const website of ["foo.classroom.google.com", "classroom.google.com.evil.example", "google.com", "ixl.com", "https://classroom.google.com@evil.example", "https://user@classroom.google.com", "file://classroom.google.com"]) {
    assert.deepEqual(payload([website]).allowedDomains, [website]);
  }
});

test("precise Classroom sections do not grant Google work app websites", () => {
  const section = { type: "section", hostname: "classroom.google.com", includeSubdomains: false, pathPrefix: "/c/123/a/456" };
  assert.deepEqual(payload([], [section]), { flightPathId: "path", flightPathName: "Work", allowedDomains: [], resources: [section] });
});

test("Google companion expansion cannot dispatch a list beyond the extension domain budget", () => {
  const domains = ["classroom.google.com", ...Array.from({ length: 994 }, (_, index) => `site-${index}.example`)];
  assert.throws(() => payload(domains), { code: "CLASSROOM_RULE_LIMIT_EXCEEDED", status: 409 });
  assert.equal(payload(domains.slice(0, 994)).allowedDomains.length, 1_000);
});

test("saved Flight Path reads expose effective domains without rewriting authoring inputs", () => {
  const saved = { id: "saved", allowedDomains: ["classroom.google.com"], resources: [] };
  const view = withFlightPathResourcesVisibility(saved, false) as typeof saved & { effectiveAllowedDomains: string[] };
  assert.deepEqual(view.effectiveAllowedDomains, ["classroom.google.com", ...companions]);
  assert.deepEqual(view.allowedDomains, ["classroom.google.com"]);
  assert.equal(Object.hasOwn(saved, "effectiveAllowedDomains"), false);
});

test("Flight Path preview describes all effective websites while saving only selected domains", async () => {
  const preview = await previewRestrictionResources("fixture", { purpose: "flight_path", allowedDomains: ["classroom.google.com"], resources: [] }, { env });
  assert.deepEqual((preview as typeof preview & { effectiveAllowedDomains: string[] }).effectiveAllowedDomains,
    ["classroom.google.com", ...companions]);
  assert.deepEqual(preview.scopes.map(scope => scope.hostname), ["classroom.google.com", ...companions]);
  assert.deepEqual(preview.authoring.allowedDomains, ["classroom.google.com"]);
});

test("Classroom import preview does not turn generated companion hosts into saved selections", async () => {
  const preview = await previewRestrictionResources("fixture", { purpose: "classroom", boundary: "website", resourceLinks: ["https://classroom.google.com/c/123"] }, { env });
  assert.deepEqual(preview.scopes.map(scope => scope.hostname), ["classroom.google.com", ...companions]);
  assert.deepEqual(preview.authoring.resourceLinks, ["https://classroom.google.com"]);
});

test("Focus website previews remain independent of the Flight Path bundle", async () => {
  const preview = await previewRestrictionResources("fixture", { purpose: "waypoint", boundary: "website", url: "https://classroom.google.com" }, { env });
  assert.deepEqual(preview.scopes.map(scope => scope.hostname), ["classroom.google.com"]);
});
