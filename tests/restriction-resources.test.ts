import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  MAX_RESTRICTION_RESOURCES,
  MAX_RESTRICTION_RESOURCES_BYTES,
  RESTRICTION_RESOURCE_RULE_ID_BUDGET,
  RestrictionResourceError,
  assertRestrictionResourceLimits,
  canonicalRestrictionHostname,
  canonicalUrlForResource,
  extractRestrictionResourceIdentity,
  isUrlAllowedByResource,
  isUrlAllowedByResources,
  legacyHostProjection,
  normalizeAllowedResource,
  normalizeAllowedResourceList,
  normalizePreciseWaypointResource,
  preciseRestrictionResources,
  resourcesRequirePreciseCapability,
  restrictionResourceRuleCount,
  restrictionResourcesRuleCount,
  validateAllowedResource,
  validateAllowedResourceList,
  type AllowedResource,
} from "../src/services/restrictionResources.js";

// The case file is the normative matcher contract shared with ClassPilot
// 2.10.0. Its hash is pinned here and in
// docs/CLASSPILOT_PRECISE_RESTRICTIONS_CONTRACT.md; changing a case changes
// the contract and needs the same change in the extension.
const RESTRICTION_RESOURCE_MATCHER_CASES_SHA256 =
  "6a7c050f39959229cafa6667a8aa0ce15dc0cbd7cd614da31b662d4776ab9e5f";

const caseFileUrl = new URL("./fixtures/restriction-resource-matcher-cases.json", import.meta.url);

type CaseFile = {
  schemaVersion: number;
  capability: string;
  identity: Array<{ name: string; url: string; expect: { provider: string; resourceId: string } | null }>;
  match: Array<{ name: string; resource: string; url: string; allowed: boolean }>;
  resources: Record<string, unknown>;
  validate: Array<{ name: string; value: unknown; valid: boolean; serverOnly?: boolean }>;
  normalize: Array<{ name: string; input: unknown; expect?: unknown; error?: string }>;
  legacyHostProjection: Array<{ name: string; resources: string[]; expect: string[] }>;
  ruleCount: Array<{ name: string; resource: string; expect: number }>;
};

const caseBytes = readFileSync(caseFileUrl);
const cases = JSON.parse(caseBytes.toString("utf8")) as CaseFile;

function namedResource(name: string): unknown {
  assert.ok(Object.prototype.hasOwnProperty.call(cases.resources, name), `case file defines resource ${name}`);
  return cases.resources[name];
}

function validResource(name: string): AllowedResource {
  const resource = validateAllowedResource(namedResource(name));
  assert.ok(resource, `${name} is a valid case-file resource`);
  return resource;
}

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof RestrictionResourceError, "only contract errors are thrown");
    assert.equal(error.status, 400);
    assert.equal(error.expose, true);
    return error.code;
  }
  return undefined;
}

describe("restriction resource matcher case file", () => {
  it("is the pinned, LF-only contract version", () => {
    assert.equal(caseBytes.includes(13), false, "the case file must stay LF-only (see .gitattributes)");
    assert.equal(createHash("sha256").update(caseBytes).digest("hex"), RESTRICTION_RESOURCE_MATCHER_CASES_SHA256);
    assert.equal(cases.schemaVersion, 1);
    assert.equal(cases.capability, "preciseRestrictionResourcesV1");
  });

  it("pins the same hash in the ClassPilot 2.10.0 contract document", () => {
    const contract = readFileSync(new URL("../docs/CLASSPILOT_PRECISE_RESTRICTIONS_CONTRACT.md", import.meta.url), "utf8");
    assert.match(contract, new RegExp(RESTRICTION_RESOURCE_MATCHER_CASES_SHA256));
  });

  for (const testCase of cases.identity) {
    it(`identity: ${testCase.name}`, () => {
      assert.deepEqual(extractRestrictionResourceIdentity(testCase.url), testCase.expect);
    });
  }

  for (const testCase of cases.match) {
    it(`match: ${testCase.name}`, () => {
      assert.equal(isUrlAllowedByResource(testCase.url, namedResource(testCase.resource)), testCase.allowed);
    });
  }

  for (const testCase of cases.validate) {
    it(`validate${testCase.serverOnly ? " (server only)" : ""}: ${testCase.name}`, () => {
      const validated = validateAllowedResource(testCase.value);
      assert.equal(validated !== null, testCase.valid);
      if (validated) assert.deepEqual(validated, testCase.value, "a valid entry round-trips unchanged");
    });
  }

  for (const testCase of cases.normalize) {
    it(`normalize: ${testCase.name}`, () => {
      if (testCase.error) {
        assert.equal(errorCode(() => normalizeAllowedResource(testCase.input)), testCase.error);
        return;
      }
      const normalized = normalizeAllowedResource(testCase.input);
      assert.deepEqual(normalized, testCase.expect);
      assert.deepEqual(validateAllowedResource(normalized), normalized, "every normalized entry validates");
    });
  }

  for (const testCase of cases.legacyHostProjection) {
    it(`legacy host projection: ${testCase.name}`, () => {
      assert.deepEqual(legacyHostProjection(testCase.resources.map(validResource)), testCase.expect);
    });
  }

  for (const testCase of cases.ruleCount) {
    it(`rule count: ${testCase.name}`, () => {
      assert.equal(restrictionResourceRuleCount(validResource(testCase.resource)), testCase.expect);
    });
  }
});

describe("restriction resource authoring rules", () => {
  it("never widens a section or resource to its host on the legacy projection", () => {
    const resources = normalizeAllowedResourceList([
      { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
      { url: "https://docs.google.com/document/d/1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ_-abcd/edit" },
      { url: "https://classroom.google.com/c/NjE2MzQ1Njc4" },
      { url: "https://www.nasa.gov/solar-system" },
    ]);
    assert.deepEqual(legacyHostProjection(resources), []);
    assert.equal(resourcesRequirePreciseCapability(resources), true);
    assert.equal(isUrlAllowedByResources("https://www.youtube.com/watch?v=9bZkp7q19f0", resources), false);
    assert.equal(isUrlAllowedByResources("https://docs.google.com/document/d/1ZzZzZzZzZ9y8x7w6v5u4t3s2r1q0pOnMlKj/edit", resources), false);
    assert.equal(isUrlAllowedByResources("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5", resources), true);
  });

  it("keeps website-only lists off the precise capability and exact to their hosts", () => {
    const resources = normalizeAllowedResourceList([
      { type: "website", hostname: "khanacademy.org" },
      { url: "https://www.ixl.com" },
    ]);
    assert.equal(resourcesRequirePreciseCapability(resources), false);
    assert.deepEqual(legacyHostProjection(resources), ["khanacademy.org", "ixl.com"]);
    assert.deepEqual(preciseRestrictionResources(resources), []);
  });

  it("collapses duplicates in first-seen order and reports the failing entry index", () => {
    const resources = normalizeAllowedResourceList([
      { url: "https://youtu.be/dQw4w9WgXcQ" },
      { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30" },
      { url: "https://www.nasa.gov/solar-system/" },
      { url: "https://nasa.gov/solar-system" },
    ]);
    assert.equal(resources.length, 2);
    let caught: unknown;
    try {
      normalizeAllowedResourceList([{ url: "https://www.nasa.gov/solar-system" }, { url: "https://www.youtube.com/" }]);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof RestrictionResourceError);
    assert.equal(caught.code, "RESOURCE_URL_UNSUPPORTED");
    assert.equal(caught.index, 1);
    assert.match(caught.message, /^Resource 2: /);
    assert.equal(errorCode(() => normalizeAllowedResourceList("https://www.youtube.com/")), "RESOURCE_INPUT_INVALID");
  });

  it("caps a list at 200 entries and fits the 997-rule classroom budget", () => {
    const videoIds = Array.from({ length: MAX_RESTRICTION_RESOURCES }, (_, index) => `video${String(index).padStart(6, "0")}`);
    const maximal = normalizeAllowedResourceList(videoIds.map((id) => ({ url: `https://youtu.be/${id}` })));
    assert.equal(maximal.length, MAX_RESTRICTION_RESOURCES);
    assert.equal(restrictionResourcesRuleCount(maximal), 400);
    assert.ok(restrictionResourcesRuleCount(maximal) <= RESTRICTION_RESOURCE_RULE_ID_BUDGET);
    assert.ok(validateAllowedResourceList(maximal));
    assert.equal(
      errorCode(() => normalizeAllowedResourceList([...videoIds, "video_extra"].map((id) => ({ url: `https://youtu.be/${id.padEnd(11, "x")}` })))),
      "RESOURCE_LIMIT_EXCEEDED"
    );
  });

  it("refuses a list whose rule demand exceeds the classroom id budget", () => {
    const tooMany = Array.from({ length: 499 }, (_, index) => validateAllowedResource({
      type: "resource",
      hostname: "youtube.com",
      includeSubdomains: false,
      provider: "youtube",
      resourceId: `v${String(index).padStart(10, "0")}`,
      canonicalUrl: `https://www.youtube.com/watch?v=v${String(index).padStart(10, "0")}`,
    })!);
    assert.equal(restrictionResourcesRuleCount(tooMany), 998);
    assert.equal(errorCode(() => assertRestrictionResourceLimits(tooMany.slice(0, 199))), undefined);
    assert.equal(errorCode(() => assertRestrictionResourceLimits(tooMany)), "RESOURCE_RULE_BUDGET_EXCEEDED");
    assert.equal(validateAllowedResourceList(tooMany), null);
  });

  it("refuses a list larger than the serialized budget", () => {
    const longPath = `/${"a".repeat(500)}`;
    const sections = Array.from({ length: 100 }, (_, index) => ({ url: `https://example${index}.edu${longPath}` }));
    const bytes = new TextEncoder().encode(JSON.stringify(sections.map((input) => normalizeAllowedResource(input)))).length;
    assert.ok(bytes > MAX_RESTRICTION_RESOURCES_BYTES);
    assert.equal(errorCode(() => normalizeAllowedResourceList(sections)), "RESOURCE_LIST_TOO_LARGE");
  });

  it("validates stored lists all-or-nothing", () => {
    const docs = validResource("googleDoc");
    assert.deepEqual(validateAllowedResourceList([docs]), [docs]);
    assert.equal(validateAllowedResourceList([docs, docs]), null, "duplicates are out of contract");
    assert.equal(validateAllowedResourceList([docs, { ...docs, canonicalUrl: "https://evil.example.com/" }]), null);
    assert.equal(validateAllowedResourceList("not a list"), null);
    assert.equal(validateAllowedResourceList(Array.from({ length: 201 }, () => docs)), null);
  });

  it("derives the Waypoint landing target from the entry", () => {
    assert.equal(canonicalUrlForResource(validResource("youtubeVideo")), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    assert.equal(canonicalUrlForResource(validResource("nasaSection")), "https://nasa.gov/solar-system");
    assert.equal(canonicalUrlForResource(validResource("khanWebsite")), "https://khanacademy.org");
  });

  it("gives a This-resource-only Waypoint one resource or section, never a whole site", () => {
    assert.equal(normalizePreciseWaypointResource("https://www.youtube.com/watch?v=dQw4w9WgXcQ").type, "resource");
    assert.equal(normalizePreciseWaypointResource("https://www.ixl.com/science/grade-7/moon-phases").type, "section");
    assert.equal(errorCode(() => normalizePreciseWaypointResource("https://www.ixl.com/")), "RESOURCE_URL_TOO_BROAD");
    assert.equal(errorCode(() => normalizePreciseWaypointResource("CURRENT_URL")), "RESOURCE_URL_INVALID");
    assert.equal(errorCode(() => normalizePreciseWaypointResource("https://forms.gle/AbCdEf123456")), "RESOURCE_SHORT_LINK_UNRESOLVED");
  });

  it("canonicalizes restriction hostnames without the SSO provider look-alike rule", () => {
    assert.equal(canonicalRestrictionHostname("docs.google.com"), "docs.google.com");
    assert.equal(canonicalRestrictionHostname("WWW.Classroom.Google.com."), "classroom.google.com");
    assert.equal(canonicalRestrictionHostname("bücher.de"), "xn--bcher-kva.de");
    assert.equal(canonicalRestrictionHostname("com"), null);
    assert.equal(canonicalRestrictionHostname("user.github.io"), "user.github.io");
    assert.equal(canonicalRestrictionHostname("github.io"), null);
    assert.equal(canonicalRestrictionHostname("10.0.0.1"), null);
    assert.equal(canonicalRestrictionHostname("example.com:443"), null);
    assert.equal(canonicalRestrictionHostname("*.example.com"), null);
    assert.equal(canonicalRestrictionHostname("example.com/path"), null);
    assert.equal(canonicalRestrictionHostname(42), null);
  });
});
