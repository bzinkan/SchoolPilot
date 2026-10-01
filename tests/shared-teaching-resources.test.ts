import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSharedTeachingResourcesEnabled } from "../src/config/sharedTeachingResources.js";
import {
  canChangeSharedResourceVisibility,
  canEditSharedResource,
  canMarkSharedResourceOfficial,
  canViewSharedResource,
  cloneBlockListInsert,
  cloneFlightPathInsert,
  copyNameForTeachingResource,
  libraryBlockListView,
  libraryFlightPathView,
  nextTeachingResourcePublication,
  ownedTeachingResourceView,
  teachingResourceChangeRequiresStrictAudit,
  teachingResourceOwnerName,
  teachingResourcePermissions,
  withoutTeachingResourcePublication,
} from "../src/services/teachingResourceLibrary.js";
import { withFlightPathResourcesVisibility } from "../src/services/classpilotPreciseRestrictions.js";
import type { BlockList, FlightPath } from "../src/schema/classpilot.js";

const DOCS_RESOURCE = {
  type: "resource" as const,
  hostname: "docs.google.com",
  includeSubdomains: false as const,
  provider: "google_docs" as const,
  resourceId: "1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ_-abcd",
  canonicalUrl: "https://docs.google.com/document/d/1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ_-abcd/edit",
};

const OWNER = "teacher-a";
const OTHER = "teacher-b";
const ADMIN = "admin-a";
const CREATED = new Date("2026-09-01T12:00:00.000Z");
const PUBLISHED = new Date("2026-09-20T12:00:00.000Z");

function flightPath(overrides: Partial<FlightPath> = {}): FlightPath {
  return {
    id: "fp-1",
    schoolId: "school-a",
    teacherId: OWNER,
    flightPathName: "Research",
    description: "Lesson sites",
    allowedDomains: ["science.example"],
    resources: [],
    blockedDomains: ["games.example"],
    isDefault: true,
    sourceType: "google_classroom",
    sourceCourseId: "course-123",
    sourceResourceIds: ["resource-1"],
    sourceUpdatedAt: CREATED,
    visibility: "private",
    official: false,
    publishedAt: null,
    publishedBy: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

function blockList(overrides: Partial<BlockList> = {}): BlockList {
  return {
    id: "bl-1",
    schoolId: "school-a",
    teacherId: OWNER,
    name: "Independent work",
    description: null,
    blockedDomains: ["games.example"],
    isDefault: true,
    visibility: "private",
    official: false,
    publishedAt: null,
    publishedBy: null,
    createdAt: CREATED,
    ...overrides,
  };
}

const teacher = (actorId: string) => ({ actorId, isAdmin: false });
const admin = { actorId: ADMIN, isAdmin: true };

describe("School Library flag", () => {
  it("is off unless the mode is exactly on", () => {
    assert.equal(isSharedTeachingResourcesEnabled("school-a", {}), false);
    for (const mode of ["off", "ON", "true", "1", " on", ""]) {
      assert.equal(isSharedTeachingResourcesEnabled("school-a", { CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE: mode }), false, mode);
    }
    assert.equal(isSharedTeachingResourcesEnabled("school-a", { CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE: "on" }), true);
  });

  it("scopes to the optional school allowlist and fails closed on a malformed list", () => {
    const on = { CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE: "on" };
    assert.equal(isSharedTeachingResourcesEnabled("school-a", { ...on, CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS: "" }), true);
    assert.equal(isSharedTeachingResourcesEnabled("school-a", { ...on, CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS: "school-a, school-c" }), true);
    assert.equal(isSharedTeachingResourcesEnabled("school-b", { ...on, CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS: "school-a,school-c" }), false);
    assert.equal(isSharedTeachingResourcesEnabled("school-a", { ...on, CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS: "school-a,,school-c" }), false);
    assert.equal(isSharedTeachingResourcesEnabled("school-a", { ...on, CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS: "school a" }), false);
    assert.equal(isSharedTeachingResourcesEnabled("", on), false);
    assert.equal(isSharedTeachingResourcesEnabled(undefined, on), false);
  });
});

describe("School Library authorization rules", () => {
  it("lets same-school members use their own and published items only", () => {
    assert.equal(canViewSharedResource(flightPath(), OWNER), true);
    assert.equal(canViewSharedResource(flightPath(), OTHER), false);
    assert.equal(canViewSharedResource(flightPath({ visibility: "school" }), OTHER), true);
    assert.equal(canViewSharedResource(flightPath({ official: true }), OTHER), true, "official is visible even when private");
    assert.equal(canViewSharedResource(flightPath({ teacherId: null }), OTHER), false);
  });

  it("keeps content changes with the owner, blocks owners of official items and leaves ownerless items to administrators", () => {
    assert.equal(canEditSharedResource(flightPath(), teacher(OWNER)), true);
    assert.equal(canEditSharedResource(flightPath({ visibility: "school" }), teacher(OTHER)), false);
    assert.equal(canEditSharedResource(flightPath({ official: true }), teacher(OWNER)), false);
    assert.equal(canEditSharedResource(flightPath({ official: true }), admin), true);
    assert.equal(canEditSharedResource(flightPath({ teacherId: null, visibility: "school" }), teacher(OTHER)), false);
    assert.equal(canEditSharedResource(flightPath({ teacherId: null, visibility: "school" }), admin), true);
  });

  it("leaves sharing to the owner; administrators may only unshare an ownerless item", () => {
    assert.equal(canChangeSharedResourceVisibility(flightPath(), teacher(OWNER), "school"), true);
    assert.equal(canChangeSharedResourceVisibility(flightPath(), admin, "school"), false, "an administrator never publishes a teacher's private item");
    assert.equal(canChangeSharedResourceVisibility(flightPath({ visibility: "school" }), admin, "private"), false);
    assert.equal(canChangeSharedResourceVisibility(flightPath({ visibility: "school" }), teacher(OTHER), "private"), false);
    assert.equal(canChangeSharedResourceVisibility(flightPath({ official: true }), teacher(OWNER), "school"), false);
    assert.equal(canChangeSharedResourceVisibility(flightPath({ official: true, teacherId: ADMIN }), admin, "school"), true);
    assert.equal(canChangeSharedResourceVisibility(flightPath({ teacherId: null, visibility: "school" }), admin, "private"), true);
    assert.equal(canChangeSharedResourceVisibility(flightPath({ teacherId: null }), admin, "school"), false);
  });

  it("marks official only as an administrator, and only shared or self-owned items", () => {
    assert.equal(canMarkSharedResourceOfficial(flightPath({ visibility: "school" }), teacher(OWNER), true), false);
    assert.equal(canMarkSharedResourceOfficial(flightPath(), admin, true), false, "another teacher's private item needs the owner's consent");
    assert.equal(canMarkSharedResourceOfficial(flightPath({ visibility: "school" }), admin, true), true);
    assert.equal(canMarkSharedResourceOfficial(flightPath({ teacherId: ADMIN }), admin, true), true);
    assert.equal(canMarkSharedResourceOfficial(flightPath({ teacherId: null }), admin, true), false);
    assert.equal(canMarkSharedResourceOfficial(flightPath({ official: true }), admin, false), true);
  });

  it("requires a strict audit for published items and for changes by someone other than the owner", () => {
    assert.equal(teachingResourceChangeRequiresStrictAudit(flightPath(), OWNER), false);
    assert.equal(teachingResourceChangeRequiresStrictAudit(flightPath({ visibility: "school" }), OWNER), true);
    assert.equal(teachingResourceChangeRequiresStrictAudit(flightPath({ official: true }), ADMIN), true);
    assert.equal(teachingResourceChangeRequiresStrictAudit(flightPath(), ADMIN), true);
    assert.equal(teachingResourceChangeRequiresStrictAudit(flightPath({ teacherId: null }), ADMIN), true);
  });

  it("reports the viewer's permissions for the UI", () => {
    assert.deepEqual(teachingResourcePermissions(flightPath(), teacher(OWNER)), { canEdit: true, canShare: true, canMarkOfficial: false });
    assert.deepEqual(teachingResourcePermissions(flightPath({ official: true, visibility: "school" }), teacher(OWNER)), { canEdit: false, canShare: false, canMarkOfficial: false });
    assert.deepEqual(teachingResourcePermissions(flightPath({ visibility: "school" }), teacher(OTHER)), { canEdit: false, canShare: false, canMarkOfficial: false });
    assert.deepEqual(teachingResourcePermissions(flightPath({ visibility: "school" }), admin), { canEdit: true, canShare: false, canMarkOfficial: true });
  });
});

describe("School Library publication metadata", () => {
  const now = new Date("2026-09-29T12:00:00.000Z");

  it("stamps a new publication and clears it when the item leaves the library", () => {
    assert.deepEqual(
      nextTeachingResourcePublication(flightPath(), { visibility: "school" }, OWNER, now),
      { visibility: "school", official: false, publishedAt: now, publishedBy: OWNER }
    );
    assert.deepEqual(
      nextTeachingResourcePublication(flightPath({ visibility: "school", publishedAt: PUBLISHED, publishedBy: OWNER }), { visibility: "private" }, OWNER, now),
      { visibility: "private", official: false, publishedAt: null, publishedBy: null }
    );
    assert.deepEqual(
      nextTeachingResourcePublication(flightPath({ visibility: "school", publishedAt: PUBLISHED, publishedBy: OWNER }), { official: true }, ADMIN, now),
      { visibility: "school", official: true, publishedAt: now, publishedBy: ADMIN }
    );
    assert.deepEqual(
      nextTeachingResourcePublication(flightPath({ visibility: "school", official: true, publishedAt: now, publishedBy: ADMIN }), { official: false }, ADMIN, PUBLISHED),
      { visibility: "school", official: false, publishedAt: now, publishedBy: ADMIN },
      "still shared, so the existing publication stamp stays"
    );
  });
});

describe("School Library copies", () => {
  it("names copies without colliding with the new owner's items", () => {
    assert.equal(copyNameForTeachingResource("Research", []), "Research");
    assert.equal(copyNameForTeachingResource("Research", ["Research"]), "Research (copy)");
    assert.equal(copyNameForTeachingResource("Research", ["Research", "Research (copy)", "Research (copy 2)"]), "Research (copy 3)");
  });

  it("copies a Flight Path as a private item owned by the copier, without the source's Classroom provenance", () => {
    const source = flightPath({ visibility: "school", official: true, publishedAt: PUBLISHED, publishedBy: ADMIN });
    const insert = cloneFlightPathInsert(source, { schoolId: "school-a", teacherId: OTHER, existingNames: ["Research"] });
    assert.deepEqual(insert, {
      schoolId: "school-a",
      teacherId: OTHER,
      flightPathName: "Research (copy)",
      description: "Lesson sites",
      allowedDomains: ["science.example"],
      resources: [],
      blockedDomains: ["games.example"],
      isDefault: false,
      sourceType: null,
      sourceCourseId: null,
      sourceResourceIds: [],
      sourceUpdatedAt: null,
      visibility: "private",
      official: false,
      publishedAt: null,
      publishedBy: null,
    });
    assert.notEqual(insert.allowedDomains, source.allowedDomains, "rule lists are copied, not shared");
  });

  it("copies precise resources verbatim whatever the school's rollout state", () => {
    // Roadmap PR 2: a copy carries its section and resource entries; they are
    // re-validated when the copy is applied, never dropped to their hosts.
    const source = flightPath({ visibility: "school", resources: [DOCS_RESOURCE] });
    const insert = cloneFlightPathInsert(source, { schoolId: "school-a", teacherId: OTHER, existingNames: [] });
    assert.deepEqual(insert.resources, [DOCS_RESOURCE]);
    assert.notEqual(insert.resources, source.resources, "the resource list is copied, not shared");
  });

  it("copies a Block List as a private item owned by the copier", () => {
    const insert = cloneBlockListInsert(blockList({ visibility: "school" }), { schoolId: "school-a", teacherId: OTHER, existingNames: [] });
    assert.deepEqual(insert, {
      schoolId: "school-a",
      teacherId: OTHER,
      name: "Independent work",
      description: null,
      blockedDomains: ["games.example"],
      isDefault: false,
      visibility: "private",
      official: false,
      publishedAt: null,
      publishedBy: null,
    });
  });
});

describe("School Library projections", () => {
  it("keeps the previous response shape when the library is off", () => {
    const row = flightPath({ visibility: "school", official: true, publishedAt: PUBLISHED, publishedBy: ADMIN });
    // Routes also omit the empty precise-resource list while that capability
    // is off for the school (roadmap PR 2).
    const legacy = withFlightPathResourcesVisibility(withoutTeachingResourcePublication(row), false);
    assert.deepEqual(Object.keys(legacy), [
      "id", "schoolId", "teacherId", "flightPathName", "description", "allowedDomains", "blockedDomains", "isDefault",
      "sourceType", "sourceCourseId", "sourceResourceIds", "sourceUpdatedAt", "createdAt", "updatedAt",
    ]);
    assert.deepEqual(Object.keys(withoutTeachingResourcePublication(blockList())), [
      "id", "schoolId", "teacherId", "name", "description", "blockedDomains", "isDefault", "createdAt",
    ]);
  });

  it("never returns published_by to the owner view", () => {
    const view = ownedTeachingResourceView(flightPath({ visibility: "school", publishedAt: PUBLISHED, publishedBy: OWNER }), teacher(OWNER));
    assert.equal("publishedBy" in view, false);
    assert.equal(view.visibility, "school");
    assert.equal(view.canShare, true);
  });

  it("shows library viewers the rules without Classroom provenance, owner id or publisher", () => {
    const view = libraryFlightPathView(flightPath({ visibility: "school", publishedAt: PUBLISHED, publishedBy: OWNER }), "Avery Teacher", teacher(OTHER));
    assert.deepEqual(view, {
      id: "fp-1",
      flightPathName: "Research",
      description: "Lesson sites",
      allowedDomains: ["science.example"],
      resources: [],
      blockedDomains: ["games.example"],
      visibility: "school",
      official: false,
      publishedAt: PUBLISHED,
      createdAt: CREATED,
      updatedAt: CREATED,
      ownerName: "Avery Teacher",
      canEdit: false,
      canShare: false,
      canMarkOfficial: false,
    });
    const blockView = libraryBlockListView(blockList({ official: true }), null, admin);
    assert.equal("teacherId" in blockView, false);
    assert.equal(blockView.ownerName, null);
    assert.equal(blockView.canMarkOfficial, true);
  });

  it("names owners from their profile and never falls back to an email", () => {
    assert.equal(teachingResourceOwnerName(null), null);
    assert.equal(teachingResourceOwnerName({ displayName: "  Ms. Rivera ", firstName: "Ana", lastName: "Rivera" }), "Ms. Rivera");
    assert.equal(teachingResourceOwnerName({ displayName: null, firstName: "Ana", lastName: "Rivera" }), "Ana Rivera");
    assert.equal(teachingResourceOwnerName({ displayName: null, firstName: null, lastName: null }), null);
  });
});
