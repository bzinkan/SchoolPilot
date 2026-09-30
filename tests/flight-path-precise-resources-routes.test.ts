import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, describe, it } from "node:test";
import { sql } from "drizzle-orm";

// Precise Flight Path resources over HTTP (roadmap PR 2). Authoring needs
// preciseRestrictionResourcesV1 active for the school; with it off every
// response keeps its previous shape and an owner can still edit the website
// part of a path that holds resources. Website entries always land in
// allowed_domains; sections and resources in the resources column.

const TAG = `cp_precise_routes_${Date.now()}`;
const DOMAIN = `${TAG}.example.edu`;
const ORIGINAL_ENV = {
  REDIS_URL: process.env.REDIS_URL,
  SENDGRID_API_KEY: process.env.SENDGRID_API_KEY,
  NODE_ENV: process.env.NODE_ENV,
  CLASSPILOT_PROTOCOL_V3_ENABLED: process.env.CLASSPILOT_PROTOCOL_V3_ENABLED,
  CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1: process.env.CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1,
  CLASSPILOT_CAPABILITY_ROLLOUTS_JSON: process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON,
  CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE: process.env.CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE,
  CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS: process.env.CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS,
};
process.env.REDIS_URL = "";
delete process.env.SENDGRID_API_KEY;
process.env.NODE_ENV = "test";
delete process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON;

const LEGACY_FLIGHT_PATH_KEYS = [
  "id", "schoolId", "teacherId", "flightPathName", "description", "allowedDomains", "blockedDomains", "isDefault",
  "sourceType", "sourceCourseId", "sourceResourceIds", "sourceUpdatedAt", "createdAt",
];

const VIDEO = {
  type: "resource",
  hostname: "youtube.com",
  includeSubdomains: false,
  provider: "youtube",
  resourceId: "dQw4w9WgXcQ",
  canonicalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
};
const SECTION = { type: "section", hostname: "nasa.gov", includeSubdomains: false, pathPrefix: "/solar-system" };
const CLASSROOM_POST = {
  type: "section",
  hostname: "classroom.google.com",
  includeSubdomains: false,
  pathPrefix: "/c/NjE2MzQ1Njc4/a/NzA4MTIzNDU2",
};
const FORM = {
  type: "resource",
  hostname: "docs.google.com",
  includeSubdomains: false,
  provider: "google_forms",
  resourceId: "e/1FAIpQLSdPublishedFormIdAbCdEfGhIjKlMnOpQrStUvWx",
  canonicalUrl: "https://docs.google.com/forms/d/e/1FAIpQLSdPublishedFormIdAbCdEfGhIjKlMnOpQrStUvWx/viewform",
};

let db: any;
let pool: any;
let sessionPool: any;
let schedulerPool: any;
let schedulerLockPool: any;
let storage: any;
let runWithTenantContext: any;
let signUserToken: any;
let server: Server;
let baseUrl: string;
let school: any;
let teacherA: any;
let teacherB: any;

function setPrecise(on: boolean): void {
  if (on) {
    process.env.CLASSPILOT_PROTOCOL_V3_ENABLED = "true";
    process.env.CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1 = "true";
  } else {
    delete process.env.CLASSPILOT_PROTOCOL_V3_ENABLED;
    delete process.env.CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1;
  }
}

function setLibrary(on: boolean): void {
  if (on) process.env.CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE = "on";
  else delete process.env.CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE;
  delete process.env.CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS;
}

function inSchool<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId: school.id }, fn);
}

async function requestJson(method: string, path: string, user: any, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${signUserToken({ userId: user.id, email: user.email, isSuperAdmin: false })}`,
      "x-school-id": school.id,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function storedPath(id: string): Promise<any> {
  return inSchool(() => storage.getFlightPathById(id, school.id));
}

before(async () => {
  const dbModule = await import("../dist/db.js");
  db = dbModule.default;
  pool = dbModule.pool;
  sessionPool = dbModule.sessionPool;
  storage = await import("../dist/services/storage.js");
  ({ runWithTenantContext } = await import("../dist/middleware/tenantContext.js"));
  ({ signUserToken } = await import("../dist/services/jwt.js"));
  const schedulerDbModule = await import("../dist/services/schedulerDb.js");
  schedulerPool = schedulerDbModule.schedulerPool;
  schedulerLockPool = schedulerDbModule.schedulerLockPool;
  school = await storage.createSchool({ name: `${TAG} School`, domain: DOMAIN, slug: `${TAG}-school`, schoolTimezone: "America/New_York" });
  [teacherA, teacherB] = await Promise.all([
    storage.createUser({ email: `teacher-a@${DOMAIN}`, firstName: "Avery", lastName: "Teacher" }),
    storage.createUser({ email: `teacher-b@${DOMAIN}`, firstName: "Blake", lastName: "Teacher" }),
  ]);
  for (const user of [teacherA, teacherB]) {
    await storage.createMembership({ userId: user.id, schoolId: school.id, role: "teacher", status: "active" });
  }
  await storage.createProductLicense({ schoolId: school.id, product: "CLASSPILOT", status: "active" });
  await storage.upsertSettings(school.id, { schoolName: school.name, wsSharedKey: "" });
  const { createApp } = await import("../dist/app.js");
  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterEach(() => {
  setPrecise(false);
  setLibrary(false);
});

after(async () => {
  try {
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (school?.id) {
      await runWithTenantContext({ isSuper: true }, () => db.transaction(async (tx: any) => {
        await tx.execute(sql`DELETE FROM audit_logs WHERE school_id = ${school.id}`);
        await tx.execute(sql`DELETE FROM flight_paths WHERE school_id = ${school.id}`);
        await tx.execute(sql`DELETE FROM product_licenses WHERE school_id = ${school.id}`);
        await tx.execute(sql`DELETE FROM school_memberships WHERE school_id = ${school.id}`);
        await tx.execute(sql`DELETE FROM settings WHERE school_id = ${school.id}`);
        await tx.execute(sql`DELETE FROM schools WHERE id = ${school.id}`);
      }));
    }
    await runWithTenantContext({ isSuper: true }, () => db.execute(sql`DELETE FROM users WHERE email LIKE ${`%@${DOMAIN}`}`));
  } finally {
    await schedulerLockPool?.end().catch(() => undefined);
    await schedulerPool?.end().catch(() => undefined);
    await sessionPool?.end().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

describe("precise Flight Path resources while the capability is off", () => {
  it("keeps today's response shape and refuses precise authoring", async () => {
    const created = await requestJson("POST", "/classpilot/flight-paths", teacherA, {
      flightPathName: `${TAG} Off`,
      allowedDomains: ["khanacademy.org"],
    });
    assert.equal(created.status, 201);
    assert.deepEqual(Object.keys(created.body.flightPath), LEGACY_FLIGHT_PATH_KEYS);
    const list = await requestJson("GET", "/classpilot/flight-paths", teacherA);
    assert.deepEqual(Object.keys(list.body), ["flightPaths"]);
    for (const row of list.body.flightPaths) assert.deepEqual(Object.keys(row), LEGACY_FLIGHT_PATH_KEYS);

    const refused = await requestJson("POST", "/classpilot/flight-paths", teacherA, {
      flightPathName: `${TAG} Refused`,
      resources: [{ url: "https://youtu.be/dQw4w9WgXcQ" }],
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "PRECISE_RESTRICTION_RESOURCES_DISABLED");
    const importRefused = await requestJson("POST", "/classpilot/flight-paths/from-classroom", teacherA, {
      courseId: "course-1",
      boundary: "resource",
      resources: [{ id: "a", links: [{ url: "https://youtu.be/dQw4w9WgXcQ" }] }],
    });
    assert.equal(importRefused.status, 409);
    assert.equal(importRefused.body.code, "PRECISE_RESTRICTION_RESOURCES_DISABLED");
    // Clearing is always allowed and never needs the rollout.
    const cleared = await requestJson("POST", "/classpilot/flight-paths", teacherA, {
      flightPathName: `${TAG} Empty`,
      allowedDomains: ["ixl.com"],
      resources: [],
    });
    assert.equal(cleared.status, 201);
    assert.deepEqual(Object.keys(cleared.body.flightPath), LEGACY_FLIGHT_PATH_KEYS);
  });

  it("lets the owner edit the website part of a path that still holds resources", async () => {
    const path = await inSchool(() => storage.createFlightPath({
      schoolId: school.id,
      teacherId: teacherA.id,
      flightPathName: `${TAG} Held`,
      allowedDomains: ["khanacademy.org"],
      resources: [SECTION, VIDEO],
    }));
    const patched = await requestJson("PATCH", `/classpilot/flight-paths/${path.id}`, teacherA, {
      flightPathName: `${TAG} Held renamed`,
      allowedDomains: ["khanacademy.org", "ixl.com"],
    });
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.body.flightPath.resources, [SECTION, VIDEO], "stored entries stay visible to their owner");
    const stored = await storedPath(path.id);
    assert.deepEqual(stored.resources, [SECTION, VIDEO], "website-only edits never touch the resources");
    assert.deepEqual(stored.allowedDomains, ["khanacademy.org", "ixl.com"]);
    const refused = await requestJson("PATCH", `/classpilot/flight-paths/${path.id}`, teacherA, {
      resources: [{ url: "https://youtu.be/dQw4w9WgXcQ" }],
    });
    assert.equal(refused.status, 409);
    const cleared = await requestJson("PATCH", `/classpilot/flight-paths/${path.id}`, teacherA, { resources: [] });
    assert.equal(cleared.status, 200);
    assert.deepEqual((await storedPath(path.id)).resources, []);
    assert.deepEqual(Object.keys(cleared.body.flightPath), LEGACY_FLIGHT_PATH_KEYS);
  });

  it("keeps the website-level Classroom import unchanged", async () => {
    const imported = await requestJson("POST", "/classpilot/flight-paths/from-classroom", teacherA, {
      courseId: "course-1",
      resources: [{ id: "a", links: [{ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }] }],
    });
    assert.equal(imported.status, 201);
    assert.deepEqual(imported.body.extracted, {
      allowedDomains: ["youtube.com"],
      domainLevelEntries: ["youtube.com"],
      resourceCount: 1,
      enforcementLevel: "hostname",
      warning: "Classroom resource links are enforced at the website hostname level, not as individual pages or videos.",
    });
    assert.deepEqual(Object.keys(imported.body.flightPath), LEGACY_FLIGHT_PATH_KEYS);
  });
});

describe("precise Flight Path resources while the capability is on", () => {
  it("advertises the feature without the School Library and returns resources", async () => {
    setPrecise(true);
    const list = await requestJson("GET", "/classpilot/flight-paths", teacherA);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.features, { preciseRestrictionResources: true });
    assert.equal("library" in list.body, false);
    for (const row of list.body.flightPaths) assert.ok(Array.isArray(row.resources));
    setLibrary(true);
    const withLibrary = await requestJson("GET", "/classpilot/flight-paths", teacherA);
    assert.deepEqual(withLibrary.body.features, { sharedTeachingResources: true, preciseRestrictionResources: true });
  });

  it("stores sections and resources in the column and websites in allowed_domains", async () => {
    setPrecise(true);
    const created = await requestJson("POST", "/classpilot/flight-paths", teacherA, {
      flightPathName: `${TAG} Moon`,
      allowedDomains: ["khanacademy.org"],
      resources: [
        { url: "https://youtu.be/dQw4w9WgXcQ?t=30" },
        { url: "https://www.nasa.gov/solar-system/" },
        { type: "website", hostname: "www.IXL.com" },
        { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
      ],
    });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.flightPath.resources, [VIDEO, SECTION]);
    assert.deepEqual(created.body.flightPath.allowedDomains, ["khanacademy.org", "ixl.com"]);
    const stored = await storedPath(created.body.flightPath.id);
    assert.deepEqual(stored.resources, [VIDEO, SECTION]);

    const patched = await requestJson("PATCH", `/classpilot/flight-paths/${stored.id}`, teacherA, {
      resources: [{ url: "https://docs.google.com/forms/d/e/1FAIpQLSdPublishedFormIdAbCdEfGhIjKlMnOpQrStUvWx/viewform?usp=sf_link" }, { url: "https://classroom.google.com" }],
    });
    assert.equal(patched.status, 200);
    assert.deepEqual((await storedPath(stored.id)).resources, [FORM], "a present list replaces the precise entries");
    assert.deepEqual((await storedPath(stored.id)).allowedDomains, ["khanacademy.org", "ixl.com", "classroom.google.com"]);
  });

  it("rejects client-chosen resource fields and out-of-contract links with contract codes", async () => {
    setPrecise(true);
    for (const [resources, code] of [
      [[VIDEO], "RESOURCE_INPUT_INVALID"],
      [[{ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", canonicalUrl: "https://evil.example.com/" }], "RESOURCE_INPUT_INVALID"],
      [[{ url: "https://www.youtube.com/" }], "RESOURCE_URL_UNSUPPORTED"],
      [[{ url: "http://www.nasa.gov/solar-system" }], "RESOURCE_URL_INVALID"],
      [[{ url: "https://github.io/solar-system" }], "RESOURCE_URL_INVALID"],
      ["https://youtu.be/dQw4w9WgXcQ", "RESOURCE_INPUT_INVALID"],
    ] as const) {
      const response = await requestJson("POST", "/classpilot/flight-paths", teacherA, {
        flightPathName: `${TAG} Invalid`,
        resources,
      });
      assert.equal(response.status, 400, JSON.stringify(resources));
      assert.equal(response.body.code, code, JSON.stringify(resources));
    }
  });

  it("imports Classroom links as resources and sections, leaving out links it cannot limit", async () => {
    setPrecise(true);
    const imported = await requestJson("POST", "/classpilot/flight-paths/from-classroom", teacherA, {
      courseId: "course-2",
      boundary: "resource",
      resources: [{
        id: "coursework-1",
        links: [
          { type: "classroom", url: "https://classroom.google.com/c/NjE2MzQ1Njc4/a/NzA4MTIzNDU2/details" },
          { type: "youtube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
          { type: "link", url: "https://www.ixl.com/math?grade=7" },
          { type: "link", url: "https://www.khanacademy.org/" },
        ],
      }],
    });
    assert.equal(imported.status, 201);
    assert.equal(imported.body.extracted.enforcementLevel, "resource");
    assert.deepEqual(imported.body.extracted.resources, [CLASSROOM_POST, VIDEO]);
    assert.deepEqual(imported.body.extracted.allowedDomains, ["khanacademy.org"]);
    assert.equal(imported.body.extracted.skippedLinkCount, 1);
    assert.match(imported.body.extracted.warning, /1 Classroom link could not be limited/);
    const stored = await storedPath(imported.body.flightPath.id);
    assert.deepEqual(stored.resources, [CLASSROOM_POST, VIDEO]);
    assert.equal(stored.sourceType, "google_classroom");
  });

  it("shows library viewers the resources and copies them verbatim", async () => {
    setPrecise(true);
    setLibrary(true);
    const shared = await inSchool(() => storage.createFlightPath({
      schoolId: school.id,
      teacherId: teacherA.id,
      flightPathName: `${TAG} Shared`,
      allowedDomains: ["khanacademy.org"],
      resources: [SECTION, VIDEO],
      visibility: "school",
    }));
    const listForB = await requestJson("GET", "/classpilot/flight-paths", teacherB);
    const libraryRow = listForB.body.library.find((row: any) => row.id === shared.id);
    assert.deepEqual(libraryRow.resources, [SECTION, VIDEO]);
    const copied = await requestJson("POST", `/classpilot/flight-paths/${shared.id}/copy`, teacherB, {});
    assert.equal(copied.status, 201);
    assert.deepEqual(copied.body.flightPath.resources, [SECTION, VIDEO]);
    assert.deepEqual((await storedPath(copied.body.flightPath.id)).resources, [SECTION, VIDEO]);
  });
});
