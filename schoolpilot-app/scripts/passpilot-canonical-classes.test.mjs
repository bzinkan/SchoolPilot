import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { preview } from "vite";
import {
  passPilotSelectedClassStorageKey,
  readPassPilotSelectedClassId,
  resolvePassPilotSidebarClassId,
  resolvePassPilotSelectedClassId,
  writePassPilotSelectedClassId,
} from "../src/products/passpilot/selectedClassSession.js";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHOOL_ID = "33333333-3333-4333-8333-333333333333";
const PASS_DATA_NOW = "2026-08-19T15:00:00.000Z";

const classTwoStudents = [
  { id: "student-two", firstName: "Taylor", lastName: "Student", studentIdNumber: "2002" },
  { id: "student-zero", firstName: "Zero", lastName: "Minutes", studentIdNumber: "2003" },
];

const officialClasses = [
  {
    id: "class-one",
    classId: "class-one",
    source: "classpilot_groups",
    name: "Grade 3 Homeroom",
    gradeLevel: "3",
    periodLabel: "8:30 AM – 9:10 AM",
    studentCount: 15,
    teacherCount: 1,
    primaryTeacher: { id: "teacher-one", name: "Mary Englert", email: "mary@example.edu" },
    coTeachers: [],
  },
  {
    id: "class-two",
    classId: "class-two",
    source: "classpilot_groups",
    name: "Grade 4 Homeroom",
    gradeLevel: "4",
    periodLabel: "8:30 AM – 9:10 AM",
    studentCount: 2,
    teacherCount: 2,
    primaryTeacher: { id: "teacher-two", name: "Cayla Couch", email: "cayla@example.edu" },
    coTeachers: [{ id: "teacher-three", name: "Casey Helper", email: "casey@example.edu" }],
  },
];

function defaultMigrationInventory() {
  const comparison = {
    classpilotGroupId: "class-one",
    className: "Grade 3 Homeroom",
    rosterAddedCount: 1,
    rosterRemovedCount: 1,
    teacherAddedCount: 1,
    teacherRemovedCount: 0,
    rosterAdded: [{ id: "student-one", name: "Jordan Student", detail: "jordan@example.edu" }],
    rosterRemoved: [{ id: "legacy-student", name: "Legacy Student", detail: "Grade 3" }],
    teacherAdded: [{ id: "teacher-one", name: "Mary Englert", detail: "mary@example.edu" }],
    teacherRemoved: [],
  };
  return {
    source: "legacy_grades",
    revision: 2,
    kioskGradeId: null,
    kioskClasspilotGroupId: null,
    canonicalClasses: officialClasses,
    items: [{
      id: "legacy-grade",
      legacyGradeId: "legacy-grade",
      name: "Legacy Advisory",
      classpilotGroupId: null,
      migrationState: "pending",
      mappingRevision: 2,
      studentCount: 1,
      teacherCount: 0,
      teacherNames: [],
      activePassCount: 0,
      historicalPassCount: 4,
      suggestedClasspilotGroupId: "class-one",
      suggestedClassName: "Grade 3 Homeroom",
      autoLinkEligible: false,
      conflictReasons: ["roster_mismatch", "teacher_mismatch"],
      comparison,
      comparisons: [comparison],
    }],
  };
}

const reportIssuers = [
  { id: "issuer-amy", displayName: "Amy Adams", status: "active" },
  { id: "issuer-andrew", displayName: "Andrew Burba", status: "active" },
  { id: "issuer-brian", displayName: "Brian Zinkan", status: "active" },
  { id: "issuer-cayla", displayName: "Cayla Couch", status: "active" },
  { id: "issuer-joanne", displayName: "Joanne Browarsky", status: "active" },
  { id: "issuer-mary", displayName: "Mary Englert", status: "active" },
  { id: "issuer-mike", displayName: "Mike Mohr", status: "active" },
  { id: "issuer-nanci", displayName: "Nanci Mays", status: "active" },
  { id: "issuer-suzanne", displayName: "Suzanne Wendell", status: "active" },
  { id: "issuer-xavier", displayName: "Xavier Young", status: "active" },
  { id: "issuer-yvonne", displayName: "Yvonne Allen", status: "active" },
  { id: "issuer-former", displayName: "Retired Rita", status: "former" },
];

function reportPass(id, firstName, destination) {
  const issuedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const returnedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  return {
    id,
    studentId: `student-${id}`,
    classpilotGroupId: "class-one",
    className: "Grade 3 Homeroom",
    classNameSnapshot: "Grade 3 Homeroom",
    student: { id: `student-${id}`, firstName, lastName: "Pagination" },
    teacher: { id: "teacher-one", firstName: "Mary", lastName: "Englert" },
    destination,
    status: "returned",
    issuedAt,
    returnedAt,
  };
}

function passDataPass({
  id,
  status,
  issuedAt,
  returnedAt = null,
  issuedVia = "teacher",
  teacherId = "issuer-brian",
  teacher = { id: "issuer-brian", firstName: "Brian", lastName: "Zinkan", name: "Brian Zinkan" },
  destination = "bathroom",
  customDestination = null,
}) {
  return {
    id,
    schoolId: SCHOOL_ID,
    studentId: "student-two",
    classpilotGroupId: "class-two",
    className: "Grade 4 Homeroom",
    classNameSnapshot: "Grade 4 Homeroom",
    student: { id: "student-two", firstName: "Taylor", lastName: "Student" },
    teacherId,
    teacher,
    destination,
    customDestination,
    status,
    issuedAt,
    returnedAt,
    issuedVia,
  };
}

const passDataHistoryPages = {
  first: {
    passes: [
      passDataPass({
        id: "active-kiosk",
        status: "active",
        issuedAt: "2026-08-19T14:55:00.000Z",
        issuedVia: "kiosk",
      }),
      passDataPass({
        id: "returned-teacher",
        status: "returned",
        issuedAt: "2026-08-19T14:00:00.000Z",
        returnedAt: "2026-08-19T14:04:00.000Z",
      }),
      passDataPass({
        id: "returned-malformed",
        status: "returned",
        issuedAt: "2026-08-19T13:30:00.000Z",
        returnedAt: "2026-08-19T13:29:00.000Z",
        destination: "other_classroom",
      }),
      passDataPass({
        id: "expired-former",
        status: "expired",
        issuedAt: "2026-08-19T13:00:00.000Z",
        teacherId: "former-staff-id",
        teacher: null,
        destination: "office",
      }),
    ],
    hasMore: true,
    nextCursor: "pass-data-page-2",
  },
  "pass-data-page-2": {
    passes: [
      passDataPass({
        id: "returned-unattributed-kiosk",
        status: "returned",
        issuedAt: "2026-08-19T12:00:00.000Z",
        returnedAt: "2026-08-19T12:01:00.000Z",
        issuedVia: "kiosk",
        teacherId: null,
        teacher: null,
        destination: "nurse",
      }),
      passDataPass({
        id: "returned-named-kiosk",
        status: "returned",
        issuedAt: "2026-08-18T16:00:00.000Z",
        returnedAt: "2026-08-18T16:02:00.000Z",
        issuedVia: "kiosk",
      }),
      passDataPass({
        id: "canceled-teacher",
        status: "canceled",
        issuedAt: "2026-08-18T15:00:00.000Z",
        destination: "counselor",
      }),
    ],
    hasMore: false,
    nextCursor: null,
  },
};

const allPassDataPasses = Object.values(passDataHistoryPages).flatMap((page) => page.passes);

function passDataHistoryForRequest(url) {
  if (url.searchParams.get("dateStart") === "2026-08-17T04:00:00.000Z") {
    return passDataHistoryPages;
  }
  return {
    first: {
      passes: allPassDataPasses.filter((pass) => pass.issuedAt.startsWith("2026-08-19")),
      hasMore: false,
      nextCursor: null,
    },
  };
}

function authResponse(role = "admin", school = {}, licenses = { classPilot: true, passPilot: true, goPilot: false }) {
  return {
    user: {
      id: role === "teacher" ? "teacher-two" : "admin-one",
      email: `${role}@example.edu`,
      firstName: role === "teacher" ? "Cayla" : "Ada",
      lastName: role === "teacher" ? "Couch" : "Admin",
      isSuperAdmin: false,
    },
    token: "passpilot-canonical-browser-token",
    activeSchoolId: SCHOOL_ID,
    licenses,
    memberships: [{
      id: `${role}-membership`,
      schoolId: SCHOOL_ID,
      role,
      schoolName: school.name || "Browser Test School",
      schoolTimezone: school.schoolTimezone || "America/New_York",
    }],
  };
}

async function installApiMocks(page, state) {
  await page.addInitScript((schoolId) => {
    window.localStorage.setItem("sp_activeSchoolId", schoolId);
  }, SCHOOL_ID);

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;

    if (
      pathname.startsWith("/api/passpilot/classes")
      || pathname.startsWith("/api/passpilot/admin/class-migration")
      || pathname === "/api/passes"
      || pathname === "/api/passes/active"
      || pathname === "/api/passpilot/passes/active"
      || pathname === "/api/passes/history"
      || pathname === "/api/passpilot/passes/issuers"
      || pathname === "/api/kiosk-config"
    ) {
      state.classModelHeaders.push({
        pathname,
        value: request.headers()["x-passpilot-class-model"] || null,
      });
    }

    if (pathname === "/api/auth/me") {
      await route.fulfill({ json: authResponse(state.role, state.settings, state.licenses) });
      return;
    }
    if (pathname === "/api/auth/csrf") {
      await route.fulfill({ json: { csrfToken: "browser-test-csrf" } });
      return;
    }
    if (pathname === "/api/passpilot/admin/settings") {
      if (request.method() === "GET") {
        state.settingsGetCount += 1;
        if (state.settingsVerificationFailuresRemaining > 0 && state.settingsWrites.length > 0) {
          state.settingsVerificationFailuresRemaining -= 1;
          await route.fulfill({
            status: 500,
            json: { error: "Saved settings could not be verified." },
          });
          return;
        }
        await route.fulfill({ json: state.settings });
        return;
      }
      if (request.method() === "PATCH") {
        const payload = request.postDataJSON();
        state.settingsWrites.push(payload);
        if (state.settingsSaveFailuresRemaining > 0) {
          state.settingsSaveFailuresRemaining -= 1;
          await route.fulfill({
            status: 500,
            json: { error: "School settings could not be saved." },
          });
          return;
        }
        if (payload.expectedRevision !== state.settings.revision) {
          await route.fulfill({
            status: 409,
            json: {
              error: "Settings were changed by another administrator. Load the latest settings and try again.",
              code: "PASSPILOT_SETTINGS_REVISION_CONFLICT",
              current: state.settings,
            },
          });
          return;
        }
        const updates = { ...payload };
        delete updates.expectedRevision;
        delete updates.kioskPin;
        state.settings = {
          ...state.settings,
          ...updates,
          ...(payload.kioskPin ? { kioskPinConfigured: true } : {}),
          revision: state.settings.revision + 1,
        };
        await new Promise((resolve) => setTimeout(resolve, 75));
        await route.fulfill({ json: state.settings });
        return;
      }
    }
    if (pathname.startsWith("/api/passpilot/admin/class-migration")) {
      if (request.method() === "GET") {
        await route.fulfill({ json: state.migration });
        return;
      }
      if (request.method() === "PUT") {
        const payload = request.postDataJSON();
        state.migrationWrites.push({ pathname, payload });
        if (state.migrationConflictsRemaining > 0) {
          state.migrationConflictsRemaining -= 1;
          if (state.migrationConflictReplacement) {
            state.migration = state.migrationConflictReplacement;
          }
          await route.fulfill({
            status: 409,
            json: {
              error: "The class mapping changed in another session. Reload before saving.",
              code: "PASSPILOT_CLASS_MIGRATION_CONFLICT",
            },
          });
          return;
        }
        const legacyGradeId = decodeURIComponent(pathname.split("/").pop());
        state.migration = {
          ...state.migration,
          revision: state.migration.revision + 1,
          items: state.migration.items.map((item) => item.legacyGradeId === legacyGradeId
            ? {
                ...item,
                classpilotGroupId: payload.action === "link" ? payload.classpilotGroupId : null,
                migrationState: payload.action === "link" ? "confirmed" : "history_only",
                mappingRevision: state.migration.revision + 1,
              }
            : item),
        };
        await route.fulfill({ json: state.migration });
        return;
      }
      if (request.method() === "POST" && pathname.endsWith("/complete")) {
        const payload = request.postDataJSON();
        state.migrationCompleteWrites.push(payload);
        state.source = "classpilot_groups";
        state.migration = { ...state.migration, source: "classpilot_groups", revision: state.migration.revision + 1 };
        await route.fulfill({ json: state.migration });
        return;
      }
    }
    if (pathname === "/api/passpilot/classes") {
      if (url.searchParams.get("scope") === "history") {
        const historyClasses = state.source === "classpilot_groups"
          ? [
              officialClasses[0],
              {
                id: "archived-class",
                classId: "archived-class",
                source: "classpilot_groups",
                name: "Archived Science",
                status: "archived",
                studentCount: 0,
                filterKey: { type: "classId", value: "archived-class" },
              },
              {
                id: "legacy-history",
                legacyGradeId: "legacy-history",
                source: "legacy_grades",
                name: "Legacy Grade 2",
                status: "archived",
                historyOnly: true,
                migrationState: "history_only",
                studentCount: 0,
                filterKey: { type: "gradeId", value: "legacy-history" },
              },
            ]
          : [{
              id: "legacy-grade",
              legacyGradeId: "legacy-grade",
              source: "legacy_grades",
              name: "Legacy Advisory",
              status: "active",
              studentCount: 1,
              filterKey: { type: "gradeId", value: "legacy-grade" },
            }];
        await route.fulfill({ json: { source: state.source, classes: historyClasses } });
        return;
      }
      const classes = state.source === "classpilot_groups"
        ? (state.emptyCanonical
          ? []
          : (state.role === "teacher" ? [officialClasses[1]] : officialClasses))
        : [{ id: "legacy-grade", classId: "legacy-grade", name: "Legacy Advisory", studentCount: 1 }];
      await route.fulfill({ json: { source: state.source, classes } });
      return;
    }
    if (pathname === "/api/passpilot/classes/class-two/students") {
      state.rosterRequests.push(pathname);
      if (state.rosterFailuresRemaining > 0) {
        state.rosterFailuresRemaining -= 1;
        await route.fulfill({
          status: 500,
          json: { error: "Canonical roster temporarily unavailable" },
        });
        return;
      }
      await route.fulfill({
        json: {
          source: "classpilot_groups",
          class: officialClasses[1],
          students: state.classTwoStudents,
        },
      });
      return;
    }
    if (pathname === "/api/passpilot/classes/class-one/students") {
      await route.fulfill({
        json: {
          source: "classpilot_groups",
          class: officialClasses[0],
          students: [{ id: "student-one", firstName: "Jordan", lastName: "Student", studentIdNumber: "2001" }],
        },
      });
      return;
    }
    if (pathname === "/api/passpilot/passes/issuers") {
      state.issuerRequests.push({
        schoolId: request.headers()["x-school-id"] || null,
        classModel: request.headers()["x-passpilot-class-model"] || null,
      });
      if (state.issuerFailuresRemaining > 0) {
        state.issuerFailuresRemaining -= 1;
        await route.fulfill({ status: 500, json: { error: "Issuer list temporarily unavailable" } });
        return;
      }
      await route.fulfill({ json: { issuers: state.reportIssuers } });
      return;
    }
    if (pathname === "/api/passes" && request.method() === "POST") {
      state.passWrites.push(request.postDataJSON());
      await route.fulfill({ status: 201, json: { id: "pass-one" } });
      return;
    }
    if (pathname === "/api/passes/active" || pathname === "/api/passpilot/passes/active") {
      state.activePassRequests.push(url.search);
      await route.fulfill({
        json: {
          classId: url.searchParams.get("classId"),
          passes: [],
        },
      });
      return;
    }
    if (pathname === "/api/passes/history") {
      state.passHistoryRequests.push(url.search);
      if (state.historyFailuresRemaining > 0) {
        state.historyFailuresRemaining -= 1;
        await route.fulfill({
          status: 500,
          json: { error: "Pass history temporarily unavailable" },
        });
        return;
      }
      if (state.historyPages) {
        const historyPages = typeof state.historyPages === "function"
          ? state.historyPages(url)
          : state.historyPages;
        const cursor = url.searchParams.get("cursor") || "first";
        const page = historyPages[cursor];
        if (!page) {
          await route.fulfill({ status: 400, json: { error: "Unexpected history cursor" } });
          return;
        }
        await route.fulfill({ json: page });
        return;
      }
      await route.fulfill({ json: { passes: [] } });
      return;
    }
    if (pathname === "/api/kiosk-config") {
      if (request.method() === "PUT") {
        const payload = request.postDataJSON();
        state.kioskWrites.push(payload);
        state.kioskClassId = state.source === "classpilot_groups"
          ? (payload.classId || null)
          : (payload.gradeId || null);
      }
      await route.fulfill({
        json: {
          source: state.source,
          classId: state.source === "classpilot_groups" ? state.kioskClassId : null,
          gradeId: state.source === "legacy_grades" ? state.kioskClassId : null,
        },
      });
      return;
    }
    if (pathname === "/api/passpilot/kiosk/sessions/mine") {
      await route.fulfill({ json: { sessions: state.kioskSessions } });
      return;
    }
    if (pathname === "/api/passpilot/kiosk/sessions/claim") {
      const payload = request.postDataJSON();
      state.kioskClaims.push(payload);
      // classId is optional: a teacher-only claim yields a classless session.
      const session = {
        id: `kiosk-session-${state.kioskClaims.length}`,
        status: "active",
        classId: payload.classId ?? null,
        className: payload.classId ? "Class Two" : null,
      };
      state.kioskSessions = [...state.kioskSessions, session];
      await route.fulfill({ json: { session } });
      return;
    }
    if (pathname === "/api/passpilot/kiosk/sessions/retarget") {
      const payload = request.postDataJSON();
      state.kioskRetargets.push(payload);
      state.kioskSessions = state.kioskSessions.map((session) => ({
        ...session,
        classId: payload.classId,
        className: "Class Two",
      }));
      await route.fulfill({ json: { updated: state.kioskSessions.length, sessions: state.kioskSessions } });
      return;
    }
    if (pathname.startsWith("/api/passpilot/kiosk/sessions/") && request.method() === "DELETE") {
      const sessionId = pathname.split("/").pop();
      state.kioskSessions = state.kioskSessions.filter((session) => session.id !== sessionId);
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (pathname === "/api/grades" || pathname === "/api/my-classes") {
      await route.fulfill({ json: { grades: [{ id: "legacy-grade", name: "Legacy Advisory" }] } });
      return;
    }
    if (pathname === "/api/grades/available") {
      await route.fulfill({ json: { grades: [] } });
      return;
    }
    if (pathname === "/api/students") {
      if (request.method() === "POST") {
        const payload = request.postDataJSON();
        state.studentWrites.push(payload);
        const failure = state.studentWriteFailures.shift();
        if (failure) {
          await route.fulfill({ status: failure.status, json: { error: failure.error, code: failure.code } });
          return;
        }
        await route.fulfill({ json: { student: { id: `student-created-${state.studentWrites.length}`, ...payload } } });
        return;
      }
      await route.fulfill({ json: { students: [{ id: "legacy-student", firstName: "Legacy", lastName: "Student", gradeId: "legacy-grade" }] } });
      return;
    }
    if (pathname === "/api/admin/attendance") {
      await route.fulfill({ json: { records: [] } });
      return;
    }
    if (
      pathname.startsWith("/api/classpilot/admin/classes/")
      && pathname.endsWith("/students")
      && request.method() === "POST"
    ) {
      const classId = pathname.split("/").at(-2);
      const payload = request.postDataJSON();
      state.adminClassAssignments.push({ classId, payload });
      await route.fulfill({ json: { added: payload.studentIds.length, alreadyPresent: 0, failed: [] } });
      return;
    }
    if (pathname === "/api/classpilot/admin/classes") {
      await route.fulfill({ json: { classes: state.adminClasses } });
      return;
    }
    if (pathname === "/api/admin/teacher-students") {
      await route.fulfill({ json: { students: state.adminStudents } });
      return;
    }
    if (pathname === "/api/admin/teachers") {
      await route.fulfill({ json: { teachers: [] } });
      return;
    }
    if (pathname === "/api/classpilot/admin/staff") {
      await route.fulfill({ json: { staff: [] } });
      return;
    }

    await route.fulfill({ status: 200, json: {} });
  });
}

function freshState(overrides = {}) {
  return {
    role: "admin",
    licenses: { classPilot: true, passPilot: true, goPilot: false },
    source: "classpilot_groups",
    rosterRequests: [],
    passWrites: [],
    classModelHeaders: [],
    passHistoryRequests: [],
    activePassRequests: [],
    reportIssuers,
    issuerRequests: [],
    issuerFailuresRemaining: 0,
    kioskClassId: "class-two",
    kioskWrites: [],
    kioskSessions: [],
    kioskClaims: [],
    kioskRetargets: [],
    emptyCanonical: false,
    rosterFailuresRemaining: 0,
    historyFailuresRemaining: 0,
    historyPages: null,
    classTwoStudents,
    migration: defaultMigrationInventory(),
    migrationWrites: [],
    migrationCompleteWrites: [],
    migrationConflictsRemaining: 0,
    migrationConflictReplacement: null,
    adminClasses: [],
    adminStudents: [],
    adminClassAssignments: [],
    studentWrites: [],
    studentWriteFailures: [],
    settings: {
      name: "Browser Test School",
      schoolTimezone: "America/New_York",
      kioskEnabled: true,
      kioskRequiresApproval: false,
      kioskPinConfigured: true,
      kioskStyle: "simple",
      revision: 4,
    },
    settingsGetCount: 0,
    settingsWrites: [],
    settingsSaveFailuresRemaining: 0,
    settingsVerificationFailuresRemaining: 0,
    ...overrides,
  };
}

test("PassPilot selected-class session state is versioned, scoped, and fail-safe", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const classes = [{ id: "class-one" }, { id: "class-two" }];
  const firstKey = passPilotSelectedClassStorageKey("user-one", "school-one");

  assert.match(firstKey, /^passpilot:selected-class:v1:/);
  assert.notEqual(firstKey, passPilotSelectedClassStorageKey("user-two", "school-one"));
  assert.notEqual(firstKey, passPilotSelectedClassStorageKey("user-one", "school-two"));

  writePassPilotSelectedClassId("user-one", "school-one", "class-two", storage);
  assert.equal(values.get(firstKey), "class-two", "storage must contain only the selected class ID");
  assert.equal(readPassPilotSelectedClassId("user-one", "school-one", storage), "class-two");
  assert.equal(readPassPilotSelectedClassId("user-two", "school-one", storage), "");

  assert.equal(resolvePassPilotSelectedClassId(classes, "class-two", "class-one"), "class-two");
  assert.equal(resolvePassPilotSelectedClassId(classes, "retired-class", "class-two"), "class-two");
  assert.equal(resolvePassPilotSelectedClassId(classes, "retired-class", "also-retired"), "class-one");
  assert.equal(resolvePassPilotSelectedClassId([], "retired-class", "also-retired"), "");
  assert.equal(resolvePassPilotSidebarClassId(classes, "class-one", "class-two"), "class-one");
  assert.equal(resolvePassPilotSidebarClassId(classes, "retired-class", "class-two"), "class-two");
  assert.equal(resolvePassPilotSidebarClassId(classes, "retired-class", "also-retired"), "");
  assert.equal(resolvePassPilotSidebarClassId([{ id: "only-class" }], "", ""), "only-class");

  writePassPilotSelectedClassId("user-one", "school-one", "", storage);
  assert.equal(values.has(firstKey), false, "an empty class inventory must clear stale session state");

  const deniedStorage = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("denied"); },
    removeItem: () => { throw new Error("denied"); },
  };
  assert.equal(readPassPilotSelectedClassId("user-one", "school-one", deniedStorage), "");
  assert.doesNotThrow(() => writePassPilotSelectedClassId("user-one", "school-one", "class-one", deniedStorage));

  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const deniedWindow = {};
  Object.defineProperty(deniedWindow, "sessionStorage", {
    configurable: true,
    get: () => { throw new Error("denied"); },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: deniedWindow,
  });
  try {
    writePassPilotSelectedClassId("denied-user", "denied-school", "class-two");
    assert.equal(
      readPassPilotSelectedClassId("denied-user", "denied-school"),
      "class-two",
      "the default in-memory cache must survive denied sessionStorage access",
    );
    writePassPilotSelectedClassId("denied-user", "denied-school", "");
    assert.equal(readPassPilotSelectedClassId("denied-user", "denied-school"), "");
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete globalThis.window;
  }
});

test("cross-product pass widgets advertise canonical capability and do not mask load errors as zero passes", async () => {
  for (const relativePath of [
    "src/shell/widgets/PassWidget.jsx",
    "src/products/classpilot/components/sidebar/PassPilotMiniView.jsx",
  ]) {
    const source = await readFile(path.join(APP_ROOT, relativePath), "utf8");
    assert.match(source, /passPilotClassRequest/);
    assert.match(source, /Passes unavailable/);
    assert.doesNotMatch(source, /api\.get\(['"]\/passpilot\/passes\/active/);
  }

  const miniView = await readFile(
    path.join(APP_ROOT, "src/products/classpilot/components/sidebar/PassPilotMiniView.jsx"),
    "utf8",
  );
  assert.match(miniView, /Go to PassPilot/);
  assert.match(miniView, /\/passpilot\/my-class\?classId=/, "the sidebar must deep-link to the selected My Class");
  assert.match(miniView, /href=\{passPilotDestination\}/, "the new-tab action must preserve My Class context");
  assert.match(miniView, /My Class — \$\{selectedClass\.name\}/);
  assert.match(miniView, /aria-expanded=\{expanded\}/);
  assert.match(miniView, /role="status"/);
  assert.match(miniView, /roster-active-passes/);
  assert.doesNotMatch(miniView, /navigate\(['"]\/passpilot\/passes/);

  const classData = await readFile(path.join(APP_ROOT, "src/products/passpilot/classData.js"), "utf8");
  const myClass = await readFile(
    path.join(APP_ROOT, "src/products/passpilot/components/tabs/MyClassTab.jsx"),
    "utf8",
  );
  assert.match(classData, /passPilotClassesQueryKey\(schoolId\)/);
  assert.match(classData, /passPilotHistoryClassesQueryKey\(schoolId\)/);
  assert.match(classData, /passPilotClassRosterQueryKey\(classId, schoolId\)/);
  assert.match(myClass, /useCanonicalPassPilotClasses\(!!schoolId, schoolId, 3000\)/);
  assert.match(myClass, /const sourceResolved = !!schoolId && classInventoryQuery\.isSuccess/);
  assert.match(myClass, /if \(!sourceResolved \|\| !userId \|\| !schoolId\) return/);
  assert.match(myClass, /\['\/api\/passes\/active', schoolId, 'roster', activeGradeId\]/);
  assert.match(myClass, /\/passes\/active\?classId=/);
  assert.match(myClass, /grade\.activePassCount/);
  assert.doesNotMatch(myClass, /AttendancePanel|showAttendance|ClipboardCheck/);
  assert.match(myClass, /['"]\/api\/passes\/history['"],\s*schoolId,/);

  const reports = await readFile(
    path.join(APP_ROOT, "src/products/passpilot/components/tabs/ReportsTab.jsx"),
    "utf8",
  );
  assert.match(reports, /csvHeaders = \["Student Name", "Class", "Issued By"/);

  const compatibilityRoutes = await readFile(path.join(APP_ROOT, "../src/routes/compat.ts"), "utf8");
  assert.match(
    compatibilityRoutes,
    /router\.get\("\/admin\/teachers",[\s\S]*?requireRole\("admin", "school_admin"\)/,
    "school administrators must be able to load the teacher choices used by official class management",
  );
  assert.match(
    compatibilityRoutes,
    /router\.get\("\/admin\/teacher-students",[\s\S]*?requireRole\("admin", "school_admin"\)/,
    "school administrators must be able to load the shared students used by official class assignment",
  );

  const authContext = await readFile(path.join(APP_ROOT, "src/contexts/AuthContext.jsx"), "utf8");
  assert.match(
    authContext,
    /const switchSchool = (?:async )?\(schoolId\) => \{[\s\S]*?setLicenses\(\{\}\);[\s\S]*?setLoading\(true\);[\s\S]*?selectActiveSchool\(schoolId\)/,
    "tenant switching must hide the prior school's licensed product controls before changing school context",
  );

  const legacyRoster = await readFile(
    path.join(APP_ROOT, "src/products/passpilot/components/tabs/RosterTab.jsx"),
    "utf8",
  );
  assert.match(
    legacyRoster,
    /apiRequest\('PUT', `\/students\/\$\{editingStudent\.id\}`,[\s\S]*?studentIdNumber: studentForm\.studentId/,
    "standalone PassPilot edits must send the canonical studentIdNumber field",
  );
});

test("PassPilot canonical classes use the persisted source and preserve the legacy path before cutover", { timeout: 90_000 }, async () => {
  const server = await preview({
    root: APP_ROOT,
    logLevel: "error",
    preview: { host: "127.0.0.1", port: 0 },
  });
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== "string", "Vite preview must listen on a local TCP port");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let browser;
  try {
    browser = await chromium.launch({ headless: true });

    const classPilotSidebarPage = await browser.newPage();
    const classPilotSidebarState = freshState({ role: "admin" });
    await installApiMocks(classPilotSidebarPage, classPilotSidebarState);
    await classPilotSidebarPage.addInitScript(({ userId, schoolId }) => {
      window.sessionStorage.setItem(
        `passpilot:selected-class:v1:${encodeURIComponent(userId)}:${encodeURIComponent(schoolId)}`,
        "retired-class",
      );
    }, { userId: "admin-one", schoolId: SCHOOL_ID });
    await classPilotSidebarPage.goto(`${baseUrl}/classpilot`);
    const sidebarClassPicker = classPilotSidebarPage.getByLabel("Select PassPilot class");
    await sidebarClassPicker.waitFor({ timeout: 15_000 });
    assert.equal(await sidebarClassPicker.inputValue(), "", "an inaccessible saved class must be cleared");
    assert.equal(
      await classPilotSidebarPage.evaluate(({ userId, schoolId }) => window.sessionStorage.getItem(
        `passpilot:selected-class:v1:${encodeURIComponent(userId)}:${encodeURIComponent(schoolId)}`,
      ), { userId: "admin-one", schoolId: SCHOOL_ID }),
      null,
      "the stale remembered selection must be removed from session storage",
    );
    const sidebarScopedPassRequest = classPilotSidebarPage.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname === "/api/passpilot/passes/active" && url.searchParams.get("classId") === "class-two";
    });
    await sidebarClassPicker.selectOption("class-two");
    await sidebarScopedPassRequest;
    await classPilotSidebarPage.getByText("My Class — Grade 4 Homeroom", { exact: true }).waitFor();
    await classPilotSidebarPage.waitForFunction(
      ({ userId, schoolId }) => window.sessionStorage.getItem(
        `passpilot:selected-class:v1:${encodeURIComponent(userId)}:${encodeURIComponent(schoolId)}`,
      ) === "class-two",
      { userId: "admin-one", schoolId: SCHOOL_ID },
    );
    assert.equal(classPilotSidebarState.activePassRequests.at(-1), "?classId=class-two");
    assert.equal(
      await classPilotSidebarPage.getByLabel("Open My Class in PassPilot in a new tab").getAttribute("href"),
      "/passpilot/my-class?classId=class-two",
    );
    await classPilotSidebarPage.getByRole("button", { name: "Go to PassPilot", exact: true }).click();
    await classPilotSidebarPage.waitForURL("**/passpilot/my-class?classId=class-two");
    await classPilotSidebarPage.close();

    const installCreateSchoolMocks = async (page, payloads) => {
      await page.route("**/api/**", async (route) => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (pathname === "/api/auth/me") {
          await route.fulfill({
            json: {
              user: {
                id: "super-admin-one",
                email: "super@example.edu",
                firstName: "Super",
                lastName: "Admin",
                isSuperAdmin: true,
              },
              token: "create-school-browser-token",
              memberships: [],
              licenses: {},
            },
          });
          return;
        }
        if (pathname === "/api/super-admin/schools" && request.method() === "POST") {
          payloads.push(request.postDataJSON());
          await route.fulfill({
            status: 201,
            json: { school: { id: `created-school-${payloads.length}` } },
          });
          return;
        }
        await route.fulfill({ status: 200, json: {} });
      });
    };

    const singleProductPayloads = [];
    const singleProductPage = await browser.newPage();
    await installCreateSchoolMocks(singleProductPage, singleProductPayloads);
    await singleProductPage.goto(`${baseUrl}/super-admin/schools/new`);
    await singleProductPage.locator('input[name="name"]').fill("Single Product School");
    await singleProductPage.locator('input[name="domain"]').fill("single.example.edu");
    await singleProductPage.getByRole("button", { name: /^ClassPilot/ }).click();
    await singleProductPage.getByRole("button", { name: "Create School", exact: true }).click();
    await singleProductPage.getByRole("heading", { name: "School Created!", exact: true }).waitFor();
    assert.equal(singleProductPayloads.length, 1);
    assert.equal(
      Object.hasOwn(singleProductPayloads[0], "passpilotClassModelAcknowledged"),
      false,
      "single-product creation must omit the canonical-only acknowledgement field",
    );

    const dualProductPayloads = [];
    const dualProductPage = await browser.newPage();
    await installCreateSchoolMocks(dualProductPage, dualProductPayloads);
    await dualProductPage.goto(`${baseUrl}/super-admin/schools/new`);
    await dualProductPage.locator('input[name="name"]').fill("Dual Product School");
    await dualProductPage.locator('input[name="domain"]').fill("dual.example.edu");
    await dualProductPage.getByRole("button", { name: /^ClassPilot/ }).click();
    await dualProductPage.getByRole("button", { name: /^PassPilot/ }).click();
    const classModelAcknowledgement = dualProductPage.getByRole("checkbox", {
      name: /Use ClassPilot classes in PassPilot/,
    });
    await classModelAcknowledgement.waitFor();
    await dualProductPage.getByRole("button", { name: "Create School", exact: true }).click();
    await dualProductPage.getByText(/Confirm that every PassPilot web, kiosk, and installed app/).waitFor();
    assert.equal(dualProductPayloads.length, 0);
    await classModelAcknowledgement.check();
    await dualProductPage.getByRole("button", { name: "Create School", exact: true }).click();
    await dualProductPage.getByRole("heading", { name: "School Created!", exact: true }).waitFor();
    assert.equal(dualProductPayloads.length, 1);
    assert.equal(dualProductPayloads[0].passpilotClassModelAcknowledged, true);

    const canonicalPage = await browser.newPage();
    const canonicalState = freshState();
    await installApiMocks(canonicalPage, canonicalState);
    await canonicalPage.goto(`${baseUrl}/passpilot/classes`);

    await canonicalPage.getByTestId("canonical-passpilot-classes").waitFor();
    await canonicalPage.getByRole("heading", { name: "Classes", exact: true }).waitFor();
    assert.equal(await canonicalPage.getByText("Managed in ClassPilot", { exact: true }).count(), 3);
    await canonicalPage.getByText("Mary Englert", { exact: true }).waitFor();
    await canonicalPage.getByText("15 students", { exact: true }).waitFor();
    assert.equal(await canonicalPage.getByRole("button", { name: /Add Class/i }).count(), 0);
    assert.equal(await canonicalPage.getByRole("button", { name: /Delete/i }).count(), 0);
    assert.match(
      await canonicalPage.getByTestId("manage-classpilot-classes").getAttribute("href"),
      /^\/classpilot\/admin\/classes\?returnTo=/,
    );

    await canonicalPage.reload();
    await canonicalPage.getByTestId("canonical-passpilot-classes").waitFor();
    assert.equal(new URL(canonicalPage.url()).pathname, "/passpilot/classes");

    await canonicalPage.goto(`${baseUrl}/passpilot`);
    await canonicalPage.waitForURL((url) => (
      url.pathname === "/passpilot/my-class" && url.searchParams.get("classId") === "class-one"
    ));
    assert.equal(
      await canonicalPage.getByTestId("button-tab-myclass").getAttribute("aria-current"),
      "page",
      "the generic PassPilot entry must land on My Class",
    );

    await canonicalPage.goto(`${baseUrl}/passpilot/my-class?classId=class-two`);
    await canonicalPage.getByText("Taylor Student", { exact: true }).waitFor();
    assert.ok(
      canonicalState.activePassRequests.some((search) => new URLSearchParams(search).get("classId") === "class-two"),
      "My Class must request active passes for the selected roster ID",
    );
    const selectedClassKey = passPilotSelectedClassStorageKey("admin-one", SCHOOL_ID);
    assert.equal(
      await canonicalPage.evaluate((key) => window.sessionStorage.getItem(key), selectedClassKey),
      "class-two",
      "a valid direct link must override and update the remembered class",
    );

    await canonicalPage.getByTestId("button-tab-roster").click();
    await canonicalPage.getByRole("heading", { name: "Classes", exact: true }).waitFor();
    const restoredRosterRequest = canonicalPage.waitForRequest((request) => (
      new URL(request.url()).pathname === "/api/passpilot/classes/class-two/students"
    ));
    await canonicalPage.getByTestId("button-tab-myclass").click();
    await restoredRosterRequest;
    await canonicalPage.getByText("Taylor Student", { exact: true }).waitFor();
    assert.equal(new URL(canonicalPage.url()).searchParams.get("classId"), "class-two");
    assert.equal(
      await canonicalPage.evaluate((key) => window.sessionStorage.getItem(key), selectedClassKey),
      "class-two",
      "My Class must restore the remembered canonical class after a tab change",
    );

    await canonicalPage.goto(`${baseUrl}/passpilot/my-class?classId=retired-class`);
    await canonicalPage.waitForURL((url) => (
      url.pathname === "/passpilot/my-class" && url.searchParams.get("classId") === "class-two"
    ));
    await canonicalPage.getByText("Taylor Student", { exact: true }).waitFor();
    // No claimed kiosks yet: Send to Kiosk opens the claim-code dialog.
    await canonicalPage.getByRole("button", { name: "Send to Kiosk", exact: true }).waitFor();
    await canonicalPage.getByRole("button", { name: "Send to Kiosk", exact: true }).click();
    await canonicalPage.getByTestId("input-kiosk-claim-code").fill("123456");
    await canonicalPage.getByTestId("button-submit-kiosk-claim").click();
    await canonicalPage.getByRole("button", { name: "On Kiosk", exact: true }).waitFor();
    assert.deepEqual(canonicalState.kioskClaims[0], { claimCode: "123456", classId: "class-two" });
    // With a claimed kiosk, the button is an explicit menu: retarget or enter a code.
    await canonicalPage.getByRole("button", { name: "On Kiosk", exact: true }).click();
    await canonicalPage.getByTestId("menu-send-to-kiosks").click();
    await canonicalPage.waitForFunction(() => document.body.textContent.includes("Kiosk Updated"));
    assert.deepEqual(canonicalState.kioskRetargets[0], { classId: "class-two" });
    // The menu always offers direct code entry as well.
    await canonicalPage.getByRole("button", { name: "On Kiosk", exact: true }).click();
    await canonicalPage.getByTestId("menu-enter-kiosk-code").click();
    await canonicalPage.getByTestId("input-kiosk-claim-code").waitFor();
    await canonicalPage.getByTestId("button-cancel-kiosk-claim").click();
    // Releasing via the kiosk chip returns to the unclaimed state.
    await canonicalPage.getByLabel("Release kiosk").click();
    await canonicalPage.getByRole("button", { name: "Send to Kiosk", exact: true }).waitFor();
    // Re-claim so the reload path below still sees an active kiosk.
    await canonicalPage.getByRole("button", { name: "Send to Kiosk", exact: true }).click();
    await canonicalPage.getByTestId("input-kiosk-claim-code").fill("654321");
    await canonicalPage.getByTestId("button-submit-kiosk-claim").click();
    await canonicalPage.getByRole("button", { name: "On Kiosk", exact: true }).waitFor();

    // The Kiosk Mode dropdown claims student-device kiosks from anywhere,
    // with an explicit class picker (no class context in the top bar).
    await canonicalPage.getByRole("button", { name: "Kiosk Mode" }).click();
    // The launcher is a single style-agnostic item — the kiosk page redirects
    // itself to the school's admin-chosen style.
    await canonicalPage.getByTestId("menu-open-kiosk").waitFor();
    assert.equal(
      await canonicalPage.getByRole("menuitem", { name: /Simple Kiosk|Badge \/ ID Kiosk/ }).count(),
      0,
      "the per-style kiosk launch items must be collapsed into one Open Kiosk item",
    );
    await canonicalPage.getByTestId("menu-claim-kiosk").click();
    // Teacher-bound claim: no class picker — the code alone binds the kiosk
    // to the teacher; a class arrives later via Send to Kiosk.
    await canonicalPage.getByTestId("input-kiosk-claim-code").waitFor();
    assert.equal(
      await canonicalPage.getByTestId("select-kiosk-claim-class").count(),
      0,
      "the claim dialog must not offer a class picker",
    );
    await canonicalPage.getByTestId("input-kiosk-claim-code").fill("222333");
    await canonicalPage.getByTestId("button-submit-kiosk-claim").click();
    await canonicalPage.waitForFunction(() => document.body.textContent.includes("Kiosk Claimed"));
    assert.deepEqual(canonicalState.kioskClaims[2], { claimCode: "222333" });
    // The classless kiosk appears under Active kiosks with no class.
    await canonicalPage.getByRole("button", { name: "Kiosk Mode" }).click();
    await canonicalPage.getByRole("menuitem", { name: "No class · kiosk" }).waitFor();
    await canonicalPage.keyboard.press("Escape");
    // A classless kiosk flips the trigger back to "Send to Kiosk" (not every
    // kiosk shows the current class). Sending retargets ALL kiosks —
    // including the freshly claimed classless one — onto the current class.
    await canonicalPage.getByRole("button", { name: "Send to Kiosk", exact: true }).click();
    await canonicalPage.getByTestId("menu-send-to-kiosks").click();
    await canonicalPage.waitForFunction(() => document.body.textContent.includes("Kiosk Updated"));
    await canonicalPage.getByRole("button", { name: "On 2 Kiosks", exact: true }).waitFor();
    // Release one of the two class-two kiosks; the survivor keeps On Kiosk.
    await canonicalPage.getByLabel("Release kiosk").last().click();
    await canonicalPage.getByRole("button", { name: "On Kiosk", exact: true }).waitFor();

    await canonicalPage.reload();
    await canonicalPage.getByText("Taylor Student", { exact: true }).waitFor();
    await canonicalPage.getByRole("button", { name: "On Kiosk", exact: true }).waitFor();
    assert.deepEqual(canonicalState.rosterRequests, [
      "/api/passpilot/classes/class-two/students",
      "/api/passpilot/classes/class-two/students",
      "/api/passpilot/classes/class-two/students",
      "/api/passpilot/classes/class-two/students",
    ]);
    await canonicalPage.getByTestId("button-checkout-student-two").click();
    await canonicalPage.getByRole("menuitem", { name: "General/Restroom" }).click();
    await canonicalPage.waitForFunction(() => document.body.textContent.includes("Pass created"));
    assert.equal(canonicalState.passWrites.length, 1);
    assert.equal(canonicalState.passWrites[0].classId, "class-two");
    assert.equal(canonicalState.passWrites[0].gradeId, undefined);
    for (const requiredPath of [
      "/api/passpilot/classes",
      "/api/passpilot/classes/class-two/students",
      "/api/passes",
    ]) {
      assert.ok(
        canonicalState.classModelHeaders.some(
          (entry) => entry.pathname === requiredPath && entry.value === "classpilot-groups-v1",
        ),
        `${requiredPath} must advertise the canonical class model capability`,
      );
    }

    const rosterFailurePage = await browser.newPage();
    const rosterFailureState = freshState({ rosterFailuresRemaining: 2 });
    await installApiMocks(rosterFailurePage, rosterFailureState);
    await rosterFailurePage.goto(`${baseUrl}/passpilot/my-class?classId=class-two`);
    await rosterFailurePage.getByRole("heading", { name: "Class roster couldn’t be loaded" }).waitFor();
    assert.equal(
      await rosterFailurePage.getByText(/This class has no students/).count(),
      0,
      "a failed canonical roster must not render the empty-roster state",
    );
    assert.equal(await rosterFailurePage.getByText("Taylor Student", { exact: true }).count(), 0);
    await rosterFailurePage.getByRole("button", { name: "Retry", exact: true }).click();
    await rosterFailurePage.getByText("Taylor Student", { exact: true }).waitFor();
    assert.equal(rosterFailureState.rosterRequests.length, 3);

    const myClassHistoryFailurePage = await browser.newPage();
    const myClassHistoryFailureState = freshState({ historyFailuresRemaining: 2 });
    await installApiMocks(myClassHistoryFailurePage, myClassHistoryFailureState);
    await myClassHistoryFailurePage.goto(`${baseUrl}/passpilot/my-class?classId=class-two`);
    await myClassHistoryFailurePage.getByText("Taylor Student", { exact: true }).waitFor();
    await myClassHistoryFailurePage.getByRole("button", { name: "Pass Data", exact: true }).click();
    await myClassHistoryFailurePage.getByText("Pass history couldn’t be loaded.", { exact: true }).waitFor();
    assert.equal(
      await myClassHistoryFailurePage.getByRole("button", { name: "Export CSV", exact: true }).count(),
      0,
      "My Class must not export a failed or partial history load",
    );
    assert.equal(await myClassHistoryFailurePage.getByText(/Total:/).count(), 0);
    await myClassHistoryFailurePage.getByRole("button", { name: "Retry", exact: true }).click();
    await myClassHistoryFailurePage.getByText(/Total:/).waitFor();
    assert.equal(myClassHistoryFailureState.passHistoryRequests.length, 3);

    const passDataContext = await browser.newContext({ timezoneId: "America/Los_Angeles" });
    const passDataPage = await passDataContext.newPage();
    await passDataPage.clock.setFixedTime(new Date(PASS_DATA_NOW));
    const passDataState = freshState({ historyPages: passDataHistoryForRequest });
    await installApiMocks(passDataPage, passDataState);
    await passDataPage.goto(`${baseUrl}/passpilot/my-class?classId=class-two`);
    await passDataPage.getByText("Taylor Student", { exact: true }).waitFor();
    const todayHistoryRequest = passDataPage.waitForRequest((request) => {
      const requestUrl = new URL(request.url());
      return requestUrl.pathname === "/api/passes/history" && !requestUrl.searchParams.has("cursor");
    });
    await passDataPage.getByRole("button", { name: "Pass Data", exact: true }).click();
    const todayRequestUrl = new URL((await todayHistoryRequest).url());
    assert.equal(todayRequestUrl.searchParams.get("dateStart"), "2026-08-19T04:00:00.000Z");
    assert.equal(todayRequestUrl.searchParams.get("dateEnd"), PASS_DATA_NOW);
    assert.equal(todayRequestUrl.searchParams.get("classId"), "class-two");
    assert.equal(todayRequestUrl.searchParams.get("gradeId"), null);
    await passDataPage.getByText("Today: Wednesday, Aug 19, 2026", { exact: true }).waitFor();
    await passDataPage.getByRole("button", { name: /Zero Minutes.*0 passes/ }).waitFor();
    await passDataPage.getByRole("button", { name: /Taylor Student.*passes/ }).click();
    await passDataPage.getByText("Total Returned Time", { exact: true }).waitFor();

    const todayDetails = passDataPage.getByTestId("pass-detail-list");
    await todayDetails.waitFor();
    assert.equal(await todayDetails.locator('article[data-testid^="pass-detail-"]').count(), 5);
    assert.match(await passDataPage.getByTestId("pass-detail-returned-teacher").innerText(), /Brian Zinkan/);
    assert.match(await passDataPage.getByTestId("pass-detail-returned-teacher").innerText(), /Returned/);
    assert.match(await passDataPage.getByTestId("pass-detail-returned-teacher").innerText(), /4 min/);
    assert.match(await passDataPage.getByTestId("pass-detail-returned-malformed").innerText(), /Returned/);
    assert.match(await passDataPage.getByTestId("pass-detail-returned-malformed").innerText(), /Duration\s+Unavailable/);
    assert.match(await passDataPage.getByTestId("pass-detail-active-kiosk").innerText(), /Brian Zinkan \(Kiosk\)/);
    assert.match(await passDataPage.getByTestId("pass-detail-active-kiosk").innerText(), /Still out/);
    assert.match(await passDataPage.getByTestId("pass-detail-active-kiosk").innerText(), /Duration\s+Pending/);
    assert.match(await passDataPage.getByTestId("pass-detail-expired-former").innerText(), /Former staff member/);
    assert.match(await passDataPage.getByTestId("pass-detail-expired-former").innerText(), /Expired/);
    assert.match(await passDataPage.getByTestId("pass-detail-expired-former").innerText(), /Duration\s+Unavailable/);
    assert.match(await passDataPage.getByTestId("pass-detail-returned-unattributed-kiosk").innerText(), /Unattributed kiosk/);
    assert.match(await passDataPage.getByTestId("pass-detail-returned-unattributed-kiosk").innerText(), /1 min/);
    await passDataPage.getByText("Returned passes only are included in time totals and averages.", { exact: true }).waitFor();
    assert.match(
      await passDataPage.getByText("Total Returned Time", { exact: true }).locator("..").innerText(),
      /5 min/,
    );

    const weekHistoryRequest = passDataPage.waitForRequest((request) => {
      const requestUrl = new URL(request.url());
      return requestUrl.pathname === "/api/passes/history"
        && requestUrl.searchParams.get("dateStart") === "2026-08-17T04:00:00.000Z"
        && !requestUrl.searchParams.has("cursor");
    });
    await passDataPage.getByRole("button", { name: "This Week", exact: true }).click();
    const weekRequest = new URL((await weekHistoryRequest).url());
    assert.equal(weekRequest.searchParams.get("dateEnd"), PASS_DATA_NOW);
    assert.equal(weekRequest.searchParams.get("classId"), "class-two");
    assert.equal(weekRequest.searchParams.get("gradeId"), null);
    await passDataPage.getByText("Current school week: Aug 17–19, 2026", { exact: true }).waitFor();
    await passDataPage.getByTestId("pass-detail-returned-named-kiosk").waitFor();
    assert.equal(await passDataPage.getByTestId("pass-detail-list").locator('article[data-testid^="pass-detail-"]').count(), 7);
    assert.match(await passDataPage.getByTestId("pass-detail-returned-named-kiosk").innerText(), /Brian Zinkan \(Kiosk\)/);
    assert.match(await passDataPage.getByTestId("pass-detail-returned-named-kiosk").innerText(), /2 min/);
    assert.match(await passDataPage.getByTestId("pass-detail-canceled-teacher").innerText(), /Canceled/);
    assert.match(await passDataPage.getByTestId("pass-detail-canceled-teacher").innerText(), /Duration\s+Unavailable/);
    assert.deepEqual(
      await passDataPage.getByTestId("pass-detail-list").locator('article[data-testid^="pass-detail-"]').evaluateAll(
        (rows) => rows.map((row) => row.getAttribute("data-testid")),
      ),
      [
        "pass-detail-active-kiosk",
        "pass-detail-returned-teacher",
        "pass-detail-returned-malformed",
        "pass-detail-expired-former",
        "pass-detail-returned-unattributed-kiosk",
        "pass-detail-returned-named-kiosk",
        "pass-detail-canceled-teacher",
      ],
      "the selected student's complete weekly history must preserve newest-first API order across pages",
    );
    assert.match(
      await passDataPage.getByText("Total Returned Time", { exact: true }).locator("..").innerText(),
      /7 min/,
    );
    assert.equal(
      passDataState.passHistoryRequests.filter((search) => new URLSearchParams(search).has("cursor")).length,
      1,
      "My Class must merge every page before presenting weekly details",
    );

    const studentCsvDownload = passDataPage.waitForEvent("download");
    await passDataPage.getByRole("button", { name: "Export CSV", exact: true }).click();
    const studentCsvPath = await (await studentCsvDownload).path();
    assert.ok(studentCsvPath, "the selected-student CSV must have a readable download path");
    const studentCsv = await readFile(studentCsvPath, "utf8");
    assert.match(studentCsv, /Total Returned Time: 7 min/);
    assert.match(studentCsv, /"Date","Checked Out","Returned","Destination","Issued By","Status","Duration"/);
    assert.match(studentCsv, /Brian Zinkan \(Kiosk\)/);
    assert.match(studentCsv, /Unattributed kiosk/);
    assert.match(studentCsv, /Former staff member/);
    assert.match(studentCsv, /"Still out","Pending"/);
    assert.match(studentCsv, /"Canceled","Unavailable"/);

    await passDataPage.getByRole("button", { name: "This Month", exact: true }).click();
    await passDataPage.getByRole("heading", { name: "Destinations", exact: true }).waitFor();
    assert.equal(await passDataPage.getByTestId("pass-detail-list").count(), 0, "monthly student data must stay summarized");
    await passDataPage.getByRole("button", { name: "This Year", exact: true }).click();
    await passDataPage.getByRole("heading", { name: "Destinations", exact: true }).waitFor();
    assert.equal(await passDataPage.getByTestId("pass-detail-list").count(), 0, "yearly student data must stay summarized");

    await passDataPage.getByTestId("tab-grade-Grade 3 Homeroom").click();
    await passDataPage.waitForURL((url) => url.searchParams.get("classId") === "class-one");
    await passDataPage.getByTestId("button-checkout-student-one").waitFor();
    assert.equal(await passDataPage.getByTestId("pass-detail-list").count(), 0, "changing class must clear the selected student detail");
    await passDataContext.close();

    const legacyPage = await browser.newPage();
    const legacyState = freshState({ source: "legacy_grades" });
    await installApiMocks(legacyPage, legacyState);
    await legacyPage.goto(`${baseUrl}/passpilot/classes`);
    await legacyPage.getByRole("button", { name: "Add Class", exact: true }).waitFor();
    await legacyPage.getByText("Legacy Advisory", { exact: true }).waitFor();
    assert.equal(await legacyPage.getByTestId("canonical-passpilot-classes").count(), 0);

    const ownedRosterPage = await browser.newPage();
    await installApiMocks(ownedRosterPage, freshState({ source: "legacy_grades" }));
    await ownedRosterPage.goto(`${baseUrl}/passpilot/setup?section=students`);
    await ownedRosterPage.getByText("School Student Directory", { exact: true }).waitFor();
    assert.equal(await ownedRosterPage.getByTestId("import-in-classpilot-notice").isVisible(), true);
    assert.equal(await ownedRosterPage.getByRole("button", { name: "Refresh roster", exact: true }).isVisible(), true);
    assert.equal(await ownedRosterPage.getByRole("button", { name: "Add Student", exact: true }).count(), 0);
    assert.equal(await ownedRosterPage.getByRole("button", { name: "Bulk Add", exact: true }).count(), 0);
    assert.equal(await ownedRosterPage.getByRole("button", { name: "Import", exact: true }).count(), 0);
    await ownedRosterPage.getByRole("tab", { name: "Classes", exact: true }).click();
    await ownedRosterPage.getByRole("button", { name: "Add Class", exact: true }).waitFor();
    assert.equal(await ownedRosterPage.getByRole("button", { name: "Assign existing students", exact: true }).isVisible(), true);
    assert.equal(await ownedRosterPage.getByRole("button", { name: "Add Student", exact: true }).count(), 0);
    await ownedRosterPage.getByRole("button", { name: "View Legacy Advisory roster", exact: true }).click();
    const setupRosterDialog = ownedRosterPage.getByRole("dialog", { name: "PassPilot Class Roster — Legacy Advisory" });
    await setupRosterDialog.getByRole("button", { name: "Refresh roster", exact: true }).waitFor();
    assert.equal(await setupRosterDialog.getByRole("button", { name: "Assign existing students", exact: true }).isVisible(), true);
    await ownedRosterPage.close();

    const standaloneRosterPage = await browser.newPage();
    const standaloneRosterState = freshState({
      source: "legacy_grades",
      licenses: { classPilot: false, passPilot: true, goPilot: false },
      studentWriteFailures: [
        { status: 400, code: "STUDENT_EMAIL_DOMAIN_MISMATCH", error: "Student email must use the school domain." },
        { status: 409, code: "STUDENT_EMAIL_CONFLICT", error: "A student with this email already exists." },
      ],
    });
    await installApiMocks(standaloneRosterPage, standaloneRosterState);
    await standaloneRosterPage.goto(`${baseUrl}/passpilot/setup?section=students`);
    assert.equal(await standaloneRosterPage.getByTestId("import-in-classpilot-notice").count(), 0);
    await standaloneRosterPage.getByRole("button", { name: "Add Student", exact: true }).click();
    const addStudentDialog = standaloneRosterPage.getByRole("dialog", { name: "Add Student", exact: true });
    await addStudentDialog.getByPlaceholder("John", { exact: true }).fill("Arielle");
    await addStudentDialog.getByPlaceholder("Doe", { exact: true }).fill("Danner");
    const emailInput = addStudentDialog.getByPlaceholder("john.doe@school.edu", { exact: true });
    await emailInput.fill("arielle@other.invalid");
    await addStudentDialog.getByPlaceholder("12345", { exact: true }).fill("A-2539");
    await addStudentDialog.getByRole("button", { name: "Add Student", exact: true }).click();
    await standaloneRosterPage.getByText("Student email must use the school domain.", { exact: false }).first().waitFor();
    await emailInput.fill("existing@example.edu");
    await addStudentDialog.getByRole("button", { name: "Add Student", exact: true }).click();
    await standaloneRosterPage.getByText("A student with this email already exists.", { exact: false }).first().waitFor();
    await emailInput.fill("");
    await addStudentDialog.getByRole("button", { name: "Add Student", exact: true }).click();
    await standaloneRosterPage.getByText("Student added", { exact: true }).waitFor();
    assert.deepEqual(standaloneRosterState.studentWrites.at(-1), {
      firstName: "Arielle",
      lastName: "Danner",
      studentIdNumber: "A-2539",
    });
    await standaloneRosterPage.close();

    const replacementComparison = {
      classpilotGroupId: "class-two",
      className: "Grade 4 Homeroom",
      rosterAddedCount: 1,
      rosterRemovedCount: 1,
      teacherAddedCount: 1,
      teacherRemovedCount: 0,
      rosterAdded: [{ id: "student-two", name: "Taylor Student", detail: "taylor@example.edu" }],
      rosterRemoved: [{ id: "legacy-student", name: "Legacy Student", detail: "Grade 3" }],
      teacherAdded: [{ id: "teacher-two", name: "Cayla Couch", detail: "cayla@example.edu" }],
      teacherRemoved: [],
    };
    const conflictReplacement = defaultMigrationInventory();
    conflictReplacement.revision = 7;
    conflictReplacement.items = conflictReplacement.items.map((item) => ({
      ...item,
      mappingRevision: 7,
      suggestedClasspilotGroupId: "class-two",
      suggestedClassName: "Grade 4 Homeroom",
      comparison: replacementComparison,
      comparisons: [replacementComparison],
    }));
    const conflictPage = await browser.newPage();
    const conflictState = freshState({
      source: "legacy_grades",
      migrationConflictsRemaining: 1,
      migrationConflictReplacement: conflictReplacement,
    });
    await installApiMocks(conflictPage, conflictState);
    await conflictPage.goto(`${baseUrl}/passpilot/setup?section=class-source`);
    await conflictPage.getByTestId("passpilot-class-source-setup").waitFor();
    await conflictPage.getByLabel("Acknowledge roster differences for Legacy Advisory").click();
    const reviewConfirmation = conflictPage
      .getByText("I reviewed every mapping and understand that ClassPilot rosters and teachers become authoritative.", { exact: true })
      .locator("..").getByRole("checkbox");
    const clientConfirmation = conflictPage
      .getByText("I confirmed the SchoolPilot web app, PassPilot Android app, and kiosks are updated for ClassPilot classes.", { exact: true })
      .locator("..").getByRole("checkbox");
    await reviewConfirmation.click();
    await clientConfirmation.click();
    await conflictPage.getByRole("button", { name: "Confirm official class", exact: true }).click();
    await conflictPage.getByRole("button", { name: "Confirm class link", exact: true }).click();
    await conflictPage.getByText("This review changed in another session", { exact: true }).waitFor();
    await conflictPage.getByRole("button", { name: "Load latest revision", exact: true }).click();
    await conflictPage.waitForFunction(() => (
      document.querySelector('[id="class-match-legacy-grade"]')?.textContent?.includes("Grade 4 Homeroom")
    ));
    assert.equal(await reviewConfirmation.getAttribute("data-state"), "unchecked");
    assert.equal(await clientConfirmation.getAttribute("data-state"), "unchecked");
    assert.equal(
      await conflictPage.getByRole("button", { name: "Confirm official class", exact: true }).isDisabled(),
      true,
      "a refreshed roster difference must be acknowledged again",
    );
    await conflictPage.close();

    const inactiveMapping = defaultMigrationInventory();
    inactiveMapping.items = inactiveMapping.items.map((item) => ({
      ...item,
      classpilotGroupId: "archived-class",
      suggestedClasspilotGroupId: null,
      suggestedClassName: null,
      migrationState: "confirmed",
      comparison: null,
      comparisons: [],
    }));
    const inactiveMappingPage = await browser.newPage();
    await installApiMocks(inactiveMappingPage, freshState({ source: "legacy_grades", migration: inactiveMapping }));
    await inactiveMappingPage.goto(`${baseUrl}/passpilot/setup?section=class-source`);
    await inactiveMappingPage.getByText("Official class unavailable", { exact: true }).waitFor();
    assert.equal(
      await inactiveMappingPage.getByRole("button", { name: "Confirm official class", exact: true }).isDisabled(),
      true,
      "a stale mapped class ID must not be submitted as an active target",
    );
    assert.equal(
      await inactiveMappingPage.getByRole("button", { name: "Switch to ClassPilot classes", exact: true }).isDisabled(),
      true,
      "an archived mapped class must reopen review and block cutover",
    );
    await inactiveMappingPage.close();

    const classSourcePage = await browser.newPage();
    const classSourceState = freshState({ source: "legacy_grades" });
    await installApiMocks(classSourcePage, classSourceState);
    await classSourcePage.goto(`${baseUrl}/passpilot/setup?section=class-source`);
    await classSourcePage.getByTestId("passpilot-class-source-setup").waitFor();
    assert.equal(
      await classSourcePage.getByRole("tab", { name: "Class Source", exact: true }).getAttribute("aria-selected"),
      "true",
    );
    assert.equal(await classSourcePage.getByRole("tab", { name: "Classes", exact: true }).count(), 1);
    assert.equal(await classSourcePage.getByRole("tab", { name: "Class Assignments", exact: true }).count(), 1);
    assert.ok(
      classSourceState.classModelHeaders.some(
        (entry) => entry.pathname === "/api/passpilot/admin/class-migration"
          && entry.value === "classpilot-groups-v1",
      ),
      "the guided migration inventory must send the canonical class-model capability",
    );

    await classSourcePage.getByLabel("Acknowledge roster differences for Legacy Advisory").click();
    await classSourcePage.getByRole("button", { name: "Confirm official class", exact: true }).click();
    await classSourcePage.getByRole("button", { name: "Confirm class link", exact: true }).click();
    await classSourcePage.getByText("Linked to Grade 3 Homeroom", { exact: true }).waitFor();
    assert.deepEqual(classSourceState.migrationWrites, [{
      pathname: "/api/passpilot/admin/class-migration/legacy-grade",
      payload: {
        expectedRevision: 2,
        action: "link",
        classpilotGroupId: "class-one",
      },
    }]);

    await classSourcePage.getByText("I reviewed every mapping and understand that ClassPilot rosters and teachers become authoritative.", { exact: true }).click();
    await classSourcePage.getByText("I confirmed the SchoolPilot web app, PassPilot Android app, and kiosks are updated for ClassPilot classes.", { exact: true }).click();
    const cutoverButton = classSourcePage.getByRole("button", { name: "Switch to ClassPilot classes", exact: true });
    assert.equal(await cutoverButton.isEnabled(), true);
    await classSourcePage.getByRole("button", { name: "Change decision", exact: true }).click();
    await classSourcePage.locator("#class-match-legacy-grade").click();
    await classSourcePage.getByRole("option", { name: /Grade 4 Homeroom/ }).click();
    assert.equal(await cutoverButton.isDisabled(), true, "an unsaved mapping draft must block irreversible cutover");
    await classSourcePage.getByRole("button", { name: "Cancel change", exact: true }).click();
    await classSourcePage.getByText("Linked to Grade 3 Homeroom", { exact: true }).waitFor();
    assert.equal(await cutoverButton.isEnabled(), true, "canceling a draft must restore the saved mapping");
    await cutoverButton.click();
    await classSourcePage.getByRole("button", { name: "Confirm irreversible cutover", exact: true }).click();
    await classSourcePage.waitForURL((url) => url.pathname === "/passpilot/classes");
    await classSourcePage.getByTestId("canonical-passpilot-classes").waitFor();
    assert.deepEqual(classSourceState.migrationCompleteWrites, [{
      expectedRevision: 3,
      classModelAcknowledged: true,
    }]);

    const canonicalClassSourcePage = await browser.newPage();
    const canonicalClassSourceState = freshState({ source: "classpilot_groups" });
    await installApiMocks(canonicalClassSourcePage, canonicalClassSourceState);
    await canonicalClassSourcePage.goto(`${baseUrl}/passpilot/setup?section=class-source`);
    await canonicalClassSourcePage.waitForFunction(() => {
      const current = new URL(window.location.href);
      return current.pathname === "/passpilot/setup" && !current.searchParams.has("section");
    });
    assert.equal(await canonicalClassSourcePage.getByRole("tab", { name: "Class Source", exact: true }).count(), 0);
    assert.equal(
      canonicalClassSourceState.classModelHeaders.filter(
        (entry) => entry.pathname.startsWith("/api/passpilot/admin/class-migration"),
      ).length,
      0,
      "canonical schools must not reopen or call the legacy migration surface",
    );

    const legacyClassSourceHashPage = await browser.newPage();
    const legacyClassSourceHashState = freshState({ source: "legacy_grades" });
    await installApiMocks(legacyClassSourceHashPage, legacyClassSourceHashState);
    await legacyClassSourceHashPage.goto(`${baseUrl}/passpilot#setup/class-source`);
    await legacyClassSourceHashPage.waitForFunction(() => {
      const current = new URL(window.location.href);
      return current.pathname === "/passpilot/setup"
        && current.searchParams.get("section") === "class-source"
        && current.hash === "";
    });
    await legacyClassSourceHashPage.getByTestId("passpilot-class-source-setup").waitFor();
    assert.equal(await legacyClassSourceHashPage.getByRole("tab", { name: "Class Source", exact: true }).count(), 1);

    const settingsPage = await browser.newPage();
    const settingsState = freshState({ source: "legacy_grades" });
    await installApiMocks(settingsPage, settingsState);
    await settingsPage.goto(`${baseUrl}/passpilot/setup?section=settings`);
    const kioskSwitch = settingsPage.getByRole("switch", { name: "Kiosk Mode Enabled", exact: true });
    await kioskSwitch.waitFor();
    assert.equal(await kioskSwitch.getAttribute("aria-checked"), "true");
    assert.equal(
      await settingsPage.getByRole("switch", { name: "Kiosk Requires Approval", exact: true }).count(),
      0,
      "the unenforced approval setting must not be presented as an operational control",
    );

    await settingsPage.getByText("Kiosk Mode Enabled", { exact: true }).click();
    assert.equal(await kioskSwitch.getAttribute("aria-checked"), "false");
    await kioskSwitch.press("Space");
    assert.equal(await kioskSwitch.getAttribute("aria-checked"), "true");
    await kioskSwitch.press("Space");
    assert.equal(await kioskSwitch.getAttribute("aria-checked"), "false");
    await settingsPage.getByLabel("School Name", { exact: true }).fill("Verified Kiosk School");
    // The timezone field is a Radix Select (combobox button), not a native <select>.
    await settingsPage.getByLabel("School Timezone", { exact: true }).click();
    await settingsPage.getByRole("option", { name: "Central (America/Chicago)", exact: true }).click();
    await settingsPage.getByLabel("Kiosk Style", { exact: true }).click();
    await settingsPage.getByRole("option", { name: "Badge / ID — students scan or type their ID", exact: true }).click();

    const saveSettingsButton = settingsPage.getByRole("button", { name: "Save Settings", exact: true });
    await saveSettingsButton.evaluate((button) => {
      button.click();
      button.click();
    });
    await settingsPage.getByText("Settings saved", { exact: true }).waitFor();
    assert.equal(settingsState.settingsWrites.length, 1, "a double-click must issue one settings write");
    assert.deepEqual(settingsState.settingsWrites[0], {
      expectedRevision: 4,
      name: "Verified Kiosk School",
      schoolTimezone: "America/Chicago",
      kioskEnabled: false,
      kioskStyle: "badge",
    });
    assert.ok(settingsState.settingsGetCount >= 2, "save must be verified through an authoritative GET");
    await settingsPage.locator("header").getByText("Verified Kiosk School", { exact: true }).waitFor();

    await settingsPage.reload();
    const reloadedKioskSwitch = settingsPage.getByRole("switch", { name: "Kiosk Mode Enabled", exact: true });
    await reloadedKioskSwitch.waitFor();
    assert.equal(await reloadedKioskSwitch.getAttribute("aria-checked"), "false");
    assert.equal(
      (await settingsPage.getByLabel("School Timezone", { exact: true }).textContent()).trim(),
      "Central (America/Chicago)",
    );
    assert.equal(
      (await settingsPage.getByLabel("Kiosk Style", { exact: true }).textContent()).trim(),
      "Badge / ID — students scan or type their ID",
    );
    assert.equal(
      await settingsPage.getByLabel("School Name", { exact: true }).inputValue(),
      "Verified Kiosk School",
    );
    assert.equal(settingsState.settingsWrites.length, 1, "reload must not write settings");

    const failedSettingsPage = await browser.newPage();
    const failedSettingsState = freshState({
      source: "legacy_grades",
      settingsSaveFailuresRemaining: 1,
    });
    await installApiMocks(failedSettingsPage, failedSettingsState);
    await failedSettingsPage.goto(`${baseUrl}/passpilot/setup?section=settings`);
    const failedDraftSwitch = failedSettingsPage.getByRole("switch", { name: "Kiosk Mode Enabled", exact: true });
    await failedDraftSwitch.waitFor();
    await failedSettingsPage.getByText("Kiosk Mode Enabled", { exact: true }).click();
    await failedSettingsPage.getByRole("button", { name: "Save Settings", exact: true }).click();
    await failedSettingsPage.getByText("School settings could not be saved.", { exact: true }).waitFor();
    assert.equal(await failedDraftSwitch.getAttribute("aria-checked"), "false");
    assert.equal(failedSettingsState.settings.kioskEnabled, true);
    assert.equal(await failedSettingsPage.getByText("Settings saved", { exact: true }).count(), 0);

    const unverifiedSettingsPage = await browser.newPage();
    const unverifiedSettingsState = freshState({
      source: "legacy_grades",
      settingsVerificationFailuresRemaining: 1,
    });
    await installApiMocks(unverifiedSettingsPage, unverifiedSettingsState);
    await unverifiedSettingsPage.goto(`${baseUrl}/passpilot/setup?section=settings`);
    const unverifiedSwitch = unverifiedSettingsPage.getByRole("switch", {
      name: "Kiosk Mode Enabled",
      exact: true,
    });
    await unverifiedSwitch.waitFor();
    await unverifiedSettingsPage.getByText("Kiosk Mode Enabled", { exact: true }).click();
    await unverifiedSettingsPage.getByRole("button", { name: "Save Settings", exact: true }).click();
    await unverifiedSettingsPage.getByText(
      "Settings were saved, but the confirmation could not be loaded. Verify the saved settings before making another change.",
      { exact: true },
    ).waitFor();
    assert.equal(await unverifiedSettingsPage.getByText("Settings saved", { exact: true }).count(), 0);
    assert.equal(await unverifiedSwitch.getAttribute("aria-checked"), "false");
    assert.equal(unverifiedSettingsState.settingsWrites.length, 1);
    await unverifiedSettingsPage.getByRole("button", { name: "Verify Saved Settings", exact: true }).click();
    await unverifiedSettingsPage.getByText("Settings saved", { exact: true }).waitFor();
    assert.equal(unverifiedSettingsState.settingsWrites.length, 1, "verification retry must not repeat the write");
    assert.equal(await unverifiedSwitch.getAttribute("aria-checked"), "false");

    const conflictSettingsPage = await browser.newPage();
    const conflictSettingsState = freshState({ source: "legacy_grades" });
    await installApiMocks(conflictSettingsPage, conflictSettingsState);
    await conflictSettingsPage.goto(`${baseUrl}/passpilot/setup?section=settings`);
    const conflictName = conflictSettingsPage.getByLabel("School Name", { exact: true });
    await conflictName.waitFor();
    await conflictName.fill("Local Unsaved School Name");
    conflictSettingsState.settings = {
      ...conflictSettingsState.settings,
      name: "Other Administrator School Name",
      kioskEnabled: false,
      revision: conflictSettingsState.settings.revision + 1,
    };
    await conflictSettingsPage.getByRole("button", { name: "Save Settings", exact: true }).click();
    await conflictSettingsPage.getByText(
      "Settings were changed by another administrator. Load the latest settings and try again.",
      { exact: true },
    ).waitFor();
    assert.equal(await conflictName.inputValue(), "Local Unsaved School Name");
    assert.equal(await conflictSettingsPage.getByText("Settings saved", { exact: true }).count(), 0);
    assert.equal(conflictSettingsState.settingsWrites.length, 1);
    await conflictSettingsPage.getByRole("button", { name: "Load latest settings", exact: true }).click();
    await conflictSettingsPage.waitForFunction(() => (
      document.querySelector("#passpilot-school-name")?.value === "Other Administrator School Name"
    ));
    assert.equal(
      await conflictSettingsPage.getByRole("switch", { name: "Kiosk Mode Enabled", exact: true }).getAttribute("aria-checked"),
      "false",
    );

    const newKioskPage = await browser.newPage();
    const newKioskState = freshState({
      source: "legacy_grades",
      settings: {
        name: "Browser Test School",
        schoolTimezone: "America/New_York",
        kioskEnabled: false,
        kioskRequiresApproval: false,
        kioskPinConfigured: false,
        revision: 9,
      },
    });
    await installApiMocks(newKioskPage, newKioskState);
    await newKioskPage.goto(`${baseUrl}/passpilot/setup?section=settings`);
    const newKioskSwitch = newKioskPage.getByRole("switch", { name: "Kiosk Mode Enabled", exact: true });
    await newKioskSwitch.waitFor();
    await newKioskPage.getByText("Kiosk Mode Enabled", { exact: true }).click();
    const newKioskSave = newKioskPage.getByRole("button", { name: "Save Settings", exact: true });
    assert.equal(await newKioskSave.isDisabled(), true);
    await newKioskPage.getByText("A kiosk PIN is required while Kiosk Mode is enabled.", { exact: true }).waitFor();
    await newKioskPage.getByLabel("Kiosk PIN", { exact: true }).fill("12ab34");
    assert.equal(await newKioskPage.getByLabel("Kiosk PIN", { exact: true }).inputValue(), "1234");
    assert.equal(await newKioskSave.isEnabled(), true);
    await newKioskSave.click();
    await newKioskPage.getByText("Settings saved", { exact: true }).waitFor();
    assert.deepEqual(newKioskState.settingsWrites[0], {
      expectedRevision: 9,
      kioskEnabled: true,
      kioskPin: "1234",
    });
    assert.equal(newKioskState.settings.kioskPinConfigured, true);

    const teacherPage = await browser.newPage();
    const teacherState = freshState({ role: "teacher" });
    await installApiMocks(teacherPage, teacherState);
    await teacherPage.goto(`${baseUrl}/passpilot/setup`);
    await teacherPage.waitForURL((url) => (
      url.pathname === "/passpilot/my-class" && url.searchParams.get("classId") === "class-two"
    ));
    assert.equal(new URL(teacherPage.url()).pathname, "/passpilot/my-class");
    assert.equal(
      await teacherPage.evaluate(
        (key) => window.sessionStorage.getItem(key),
        passPilotSelectedClassStorageKey("teacher-two", SCHOOL_ID),
      ),
      "class-two",
      "a teacher with one class must persist that accessible class for this school",
    );
    await teacherPage.goto(`${baseUrl}/passpilot/reports`);
    await teacherPage.getByText("Total Passes", { exact: true }).waitFor();
    assert.equal(await teacherPage.getByLabel("Issued By").count(), 0, "teachers must not see the school-wide issuer filter");
    await teacherPage.waitForTimeout(50);
    assert.equal(teacherState.issuerRequests.length, 0, "teachers must not request the manager-only issuer endpoint");

    const weekReportContext = await browser.newContext({ timezoneId: "America/Los_Angeles" });
    const weekReportPage = await weekReportContext.newPage();
    await weekReportPage.clock.setFixedTime(new Date(PASS_DATA_NOW));
    const weekReportState = freshState();
    await installApiMocks(weekReportPage, weekReportState);
    await weekReportPage.goto(`${baseUrl}/passpilot/reports`);
    await weekReportPage.getByText("Total Passes", { exact: true }).waitFor();
    const reportWeekRequest = weekReportPage.waitForRequest((request) => {
      const requestUrl = new URL(request.url());
      return requestUrl.pathname === "/api/passes/history"
        && requestUrl.searchParams.get("dateStart") === "2026-08-17T04:00:00.000Z";
    });
    await weekReportPage.getByLabel("Date Range").click();
    await weekReportPage.getByRole("option", { name: "This Week", exact: true }).click();
    const reportWeekUrl = new URL((await reportWeekRequest).url());
    assert.equal(reportWeekUrl.searchParams.get("dateEnd"), PASS_DATA_NOW);
    assert.equal(
      (await weekReportPage.getByTestId("report-week-range").innerText()).replace(/\s+/g, " ").trim(),
      "Current school week: Aug 17–19, 2026",
    );
    await weekReportContext.close();

    const officePage = await browser.newPage();
    const officeState = freshState({ role: "office_staff", emptyCanonical: true });
    await installApiMocks(officePage, officeState);
    const officeSelectedClassKey = passPilotSelectedClassStorageKey("admin-one", SCHOOL_ID);
    await officePage.addInitScript(({ storageKey }) => {
      window.sessionStorage.setItem(storageKey, "retired-class");
    }, { storageKey: officeSelectedClassKey });
    await officePage.goto(`${baseUrl}/passpilot/my-class?classId=stale-query-class`);
    await officePage.getByRole("heading", { name: "No official classes yet", exact: true }).waitFor();
    await officePage.waitForURL((url) => (
      url.pathname === "/passpilot/my-class" && !url.searchParams.has("classId")
    ));
    assert.equal(
      await officePage.evaluate((key) => window.sessionStorage.getItem(key), officeSelectedClassKey),
      null,
      "a zero-class inventory must clear stale session selection",
    );
    await officePage.getByTestId("button-tab-roster").click();
    await officePage.waitForURL((url) => url.pathname === "/passpilot/classes");
    await officePage.getByRole("heading", { name: "Classes", exact: true }).waitFor();
    await officePage.getByText("No official classes yet", { exact: true }).waitFor();
    assert.equal(await officePage.getByText("No ClassPilot classes are assigned to you", { exact: true }).count(), 0);
    assert.equal(await officePage.getByTestId("manage-classpilot-classes").count(), 0);
    await officePage.getByRole("link", { name: "Reports" }).click();
    await officePage.waitForURL("**/passpilot/reports");
    const reportIssuerSelect = officePage.getByLabel("Issued By");
    await reportIssuerSelect.click();
    const brianIssuerOption = officePage.getByRole("option", { name: "Brian Zinkan", exact: true });
    await brianIssuerOption.waitFor();
    const issuerOptionLabels = await officePage.getByRole("option").allTextContents();
    assert.equal(issuerOptionLabels.length, officeState.reportIssuers.length + 1, "the issuer menu must render every returned staff member");
    assert.ok(issuerOptionLabels.includes("Yvonne Allen"), "the alphabetically last active issuer must not be truncated by the menu");
    assert.equal(issuerOptionLabels.at(-1), "Retired Rita (Former staff)", "former staff must sort after active issuers");
    assert.ok(issuerOptionLabels.includes("Retired Rita (Former staff)"), "former staff must be labeled distinctly");
    const brianHistoryRequest = officePage.waitForRequest((request) => {
      const requestUrl = new URL(request.url());
      return requestUrl.pathname === "/api/passes/history"
        && requestUrl.searchParams.get("teacherId") === "issuer-brian";
    });
    await brianIssuerOption.click();
    const filteredByBrianRequest = await brianHistoryRequest;
    assert.equal(new URL(filteredByBrianRequest.url()).searchParams.get("teacherId"), "issuer-brian");
    assert.equal(officeState.issuerRequests.length, 1);
    assert.deepEqual(officeState.issuerRequests[0], {
      schoolId: SCHOOL_ID,
      classModel: "classpilot-groups-v1",
    });
    const reportClassSelect = officePage.getByLabel("Class");
    await reportClassSelect.click();
    await officePage.getByText("Legacy class history", { exact: true }).waitFor();
    const legacyHistoryRequest = officePage.waitForRequest((request) => {
      const requestUrl = new URL(request.url());
      return requestUrl.pathname === "/api/passes/history"
        && requestUrl.searchParams.get("gradeId") === "legacy-history";
    });
    await officePage.getByRole("option", { name: "Legacy Grade 2 (History only)" }).click();
    await legacyHistoryRequest;
    await reportClassSelect.click();
    const archivedClassRequest = officePage.waitForRequest((request) => {
      const requestUrl = new URL(request.url());
      return requestUrl.pathname === "/api/passes/history"
        && requestUrl.searchParams.get("classId") === "archived-class";
    });
    await officePage.getByRole("option", { name: "Archived Science (Archived)" }).click();
    await archivedClassRequest;

    const issuerFailurePage = await browser.newPage();
    const issuerFailureState = freshState({ issuerFailuresRemaining: 2 });
    await installApiMocks(issuerFailurePage, issuerFailureState);
    await issuerFailurePage.goto(`${baseUrl}/passpilot/reports`);
    await issuerFailurePage.getByText("Issuer options couldn’t be loaded.", { exact: true }).waitFor();
    assert.equal(await issuerFailurePage.getByLabel("Issued By").isDisabled(), true);
    const issuerRetryResponse = issuerFailurePage.waitForResponse((response) => (
      new URL(response.url()).pathname === "/api/passpilot/passes/issuers" && response.status() === 200
    ));
    await issuerFailurePage.getByRole("button", { name: "Retry", exact: true }).click();
    await issuerRetryResponse;
    await issuerFailurePage.waitForFunction(() => !document.querySelector("#reportIssuer")?.disabled);
    await issuerFailurePage.getByLabel("Issued By").click();
    await issuerFailurePage.getByRole("option", { name: "Brian Zinkan", exact: true }).waitFor();

    const reportFailurePage = await browser.newPage();
    const reportFailureState = freshState({ historyFailuresRemaining: 2 });
    await installApiMocks(reportFailurePage, reportFailureState);
    await reportFailurePage.goto(`${baseUrl}/passpilot/reports`);
    await reportFailurePage.getByRole("heading", { name: "Report data couldn’t be loaded" }).waitFor();
    assert.equal(
      await reportFailurePage.getByText("Total Passes", { exact: true }).count(),
      0,
      "a failed history page must not render false zero totals",
    );
    assert.equal(
      await reportFailurePage.getByRole("button", { name: "Export CSV", exact: true }).count(),
      0,
      "partial or failed history must not expose export",
    );
    assert.equal(await reportFailurePage.getByText("No activity today", { exact: true }).count(), 0);
    await reportFailurePage.getByRole("button", { name: "Retry", exact: true }).click();
    await reportFailurePage.getByText("Total Passes", { exact: true }).waitFor();
    assert.equal(reportFailureState.passHistoryRequests.length, 3);

    const paginatedReportPage = await browser.newPage();
    const paginatedReportState = freshState({
      historyPages: {
        first: {
          passes: [reportPass("page-one", "Page One", "bathroom")],
          hasMore: true,
          nextCursor: "page-2",
        },
        "page-2": {
          passes: [reportPass("page-two", "Page Two", "nurse")],
          hasMore: false,
          nextCursor: null,
        },
      },
    });
    await installApiMocks(paginatedReportPage, paginatedReportState);
    await paginatedReportPage.goto(`${baseUrl}/passpilot/reports`);
    const totalPassesLabel = paginatedReportPage.getByText("Total Passes", { exact: true });
    await totalPassesLabel.waitFor();
    assert.match(
      (await totalPassesLabel.locator("..").textContent()) || "",
      /2\s*Total Passes/,
      "report totals must include every history page",
    );
    assert.equal(paginatedReportState.passHistoryRequests.length, 2);
    const firstHistoryRequest = new URLSearchParams(paginatedReportState.passHistoryRequests[0]);
    const secondHistoryRequest = new URLSearchParams(paginatedReportState.passHistoryRequests[1]);
    assert.equal(firstHistoryRequest.get("limit"), "500");
    assert.equal(firstHistoryRequest.get("cursor"), null);
    assert.equal(secondHistoryRequest.get("limit"), "500");
    assert.equal(secondHistoryRequest.get("cursor"), "page-2");

    const downloadPromise = paginatedReportPage.waitForEvent("download");
    await paginatedReportPage.getByRole("button", { name: "Export CSV", exact: true }).click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    assert.ok(downloadPath, "CSV download must have a readable local path");
    const csv = await readFile(downloadPath, "utf8");
    assert.match(csv, /Page One Pagination/);
    assert.match(csv, /Page Two Pagination/);
    await paginatedReportPage.getByText("Export Complete", { exact: true }).waitFor();

    const staleKioskPage = await browser.newPage();
    await staleKioskPage.addInitScript(() => {
      window.localStorage.setItem("pp_kiosk_pin", "1234");
    });
    const staleKioskHeaders = [];
    await staleKioskPage.route("**/api/passpilot/kiosk/**", async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      staleKioskHeaders.push(request.headers()["x-passpilot-class-model"] || null);
      if (pathname.endsWith("/auth") || pathname.endsWith("/snapshot")) {
        // An archived server predates both additive kiosk contracts. The
        // client must feature-detect these plain 404s and preserve the
        // existing PIN/config flow.
        await route.fulfill({ status: 404, json: { error: "Not found" } });
        return;
      }
      if (pathname.endsWith("/session")) {
        // Legacy server without per-device kiosk sessions: the kiosk must
        // feature-detect the 404 and stay on the school-global flow.
        await route.fulfill({ status: 404, json: { error: "Not found" } });
        return;
      }
      if (pathname.endsWith("/grades")) {
        await route.fulfill({ json: { source: "classpilot_groups", classes: [] } });
        return;
      }
      if (pathname.endsWith("/config")) {
        await route.fulfill({
          status: 409,
          json: {
            source: "classpilot_groups",
            code: "PASSPILOT_KIOSK_CLASS_INACTIVE",
            error: "The configured kiosk class is no longer active.",
          },
        });
        return;
      }
      await route.fulfill({ status: 500, json: { error: "Unexpected kiosk request" } });
    });
    await staleKioskPage.goto(`${baseUrl}/passpilot/kiosk/simple?school=${SCHOOL_ID}`);
    await staleKioskPage.getByRole("heading", { name: "Kiosk Class Required" }).waitFor();
    await staleKioskPage.getByText(/configured ClassPilot class is no longer active/).waitFor();
    assert.equal(await staleKioskPage.getByText("No students in this class", { exact: true }).count(), 0);
    assert.ok(staleKioskHeaders.every((value) => value === "classpilot-groups-v1"));

    // The kiosk style is school-wide: a simple kiosk on a badge school hops to
    // the badge page, carrying its session id (session keys are page-scoped).
    const styleRedirectPage = await browser.newPage();
    await styleRedirectPage.addInitScript(() => {
      window.localStorage.setItem("pp_kiosk_pin", "1234");
    });
    const styleSessionHeaders = [];
    let styleRedirectStyle = "badge";
    await styleRedirectPage.route("**/api/passpilot/kiosk/**", async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname.endsWith("/auth") || pathname.endsWith("/snapshot")) {
        await route.fulfill({ status: 404, json: { error: "Not found" } });
        return;
      }
      if (pathname.endsWith("/session")) {
        styleSessionHeaders.push(request.headers()["x-kiosk-session"] || null);
        await route.fulfill({
          status: 201,
          json: {
            session: { id: "style-session", status: "unclaimed", claimCode: "111222" },
            kioskStyle: styleRedirectStyle,
          },
        });
        return;
      }
      if (pathname.endsWith("/config")) {
        await route.fulfill({
          json: {
            session: { id: "style-session", status: "unclaimed", claimCode: "111222" },
            source: null,
            classId: null,
            gradeId: null,
            className: null,
            kioskName: null,
            kioskEnabled: true,
            kioskRequiresApproval: false,
            defaultPassDuration: 5,
            kioskStyle: styleRedirectStyle,
          },
        });
        return;
      }
      await route.fulfill({ status: 500, json: { error: "Unexpected kiosk request" } });
    });
    await styleRedirectPage.goto(`${baseUrl}/passpilot/kiosk/simple?school=${SCHOOL_ID}`);
    await styleRedirectPage.waitForURL("**/passpilot/kiosk?**");
    await styleRedirectPage.getByTestId("kiosk-claim-code").waitFor();
    await styleRedirectPage.getByText("111 222", { exact: true }).waitFor();
    assert.equal(
      styleSessionHeaders.at(-1),
      "style-session",
      "the badge page must resume the redirected session instead of minting a new one",
    );
    // Flip-while-open: an admin changes the style while the kiosk is running.
    // The badge page's config poll must observe it and hop back with no
    // reload, resuming the same session; then the simple page's poll must hop
    // forward again when the style flips once more.
    styleRedirectStyle = "simple";
    await styleRedirectPage.waitForURL("**/passpilot/kiosk/simple?**", { timeout: 30_000 });
    await styleRedirectPage.getByTestId("kiosk-claim-code").waitFor();
    assert.equal(styleSessionHeaders.at(-1), "style-session");
    styleRedirectStyle = "badge";
    await styleRedirectPage.waitForURL("**/passpilot/kiosk?**", { timeout: 30_000 });
    await styleRedirectPage.getByTestId("kiosk-claim-code").waitFor();
    assert.equal(styleSessionHeaders.at(-1), "style-session");

    // Gate-launched kiosks (ClassPilot extension on a shared student device)
    // keep launch=gate across the style hop: the PIN lives in sessionStorage
    // under that mode, and losing the marker would strand the PIN lookup in
    // localStorage — re-prompting staff on a student profile.
    const gateRedirectPage = await browser.newPage();
    await gateRedirectPage.addInitScript(() => {
      window.sessionStorage.setItem("pp_kiosk_pin", "1234");
    });
    await gateRedirectPage.route("**/api/passpilot/kiosk/**", async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname.endsWith("/auth") || pathname.endsWith("/snapshot")) {
        await route.fulfill({ status: 404, json: { error: "Not found" } });
        return;
      }
      if (pathname.endsWith("/session")) {
        await route.fulfill({
          status: 201,
          json: {
            session: { id: "gate-session", status: "unclaimed", claimCode: "444555" },
            kioskStyle: "badge",
          },
        });
        return;
      }
      if (pathname.endsWith("/config")) {
        await route.fulfill({
          json: {
            session: { id: "gate-session", status: "unclaimed", claimCode: "444555" },
            source: null,
            classId: null,
            gradeId: null,
            className: null,
            kioskName: null,
            kioskEnabled: true,
            kioskRequiresApproval: false,
            defaultPassDuration: 5,
            kioskStyle: "badge",
          },
        });
        return;
      }
      await route.fulfill({ status: 500, json: { error: "Unexpected kiosk request" } });
    });
    await gateRedirectPage.goto(`${baseUrl}/passpilot/kiosk/simple?school=${SCHOOL_ID}&launch=gate`);
    await gateRedirectPage.waitForURL(
      (url) => url.pathname === "/passpilot/kiosk" && url.searchParams.get("launch") === "gate",
    );
    // Claim code renders only if the target page found the PIN — which, in
    // gate mode, requires launch=gate to have survived the redirect.
    await gateRedirectPage.getByTestId("kiosk-claim-code").waitFor();
    await gateRedirectPage.getByText("444 555", { exact: true }).waitFor();

    // Managed-device identity: the ClassPilot extension appends ?device= to
    // the kiosk launch URL. The page adopts it over any random localStorage
    // id (normalized lowercase), strips it from the URL, and it survives
    // reloads — this is what makes kiosk memory outlive profile wipes.
    const FIXED_DEVICE = "abcdefab-1234-4abc-8def-abcdefabcdef";
    const devicePage = await browser.newPage();
    await devicePage.addInitScript(() => {
      // Init scripts re-run on reload — seed the pre-existing random id only
      // once so the reload leg actually observes the adopted value.
      window.localStorage.setItem("pp_kiosk_pin", "1234");
      if (!window.localStorage.getItem("pp_kiosk_device")) {
        window.localStorage.setItem("pp_kiosk_device", "99999999-9999-4999-8999-999999999999");
      }
    });
    const deviceHeadersSeen = [];
    await devicePage.route("**/api/passpilot/kiosk/**", async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname.endsWith("/auth") || pathname.endsWith("/snapshot")) {
        await route.fulfill({ status: 404, json: { error: "Not found" } });
        return;
      }
      if (pathname.endsWith("/session")) {
        deviceHeadersSeen.push(request.headers()["x-kiosk-device"] || null);
        await route.fulfill({
          status: 201,
          json: {
            session: { id: "device-session", status: "unclaimed", claimCode: "999000" },
            kioskStyle: "simple",
            resume: null,
          },
        });
        return;
      }
      if (pathname.endsWith("/config")) {
        await route.fulfill({
          json: {
            session: { id: "device-session", status: "unclaimed", claimCode: "999000" },
            source: null,
            classId: null,
            gradeId: null,
            className: null,
            kioskName: null,
            kioskEnabled: true,
            kioskRequiresApproval: false,
            defaultPassDuration: 5,
            kioskStyle: "simple",
          },
        });
        return;
      }
      await route.fulfill({ status: 500, json: { error: "Unexpected kiosk request" } });
    });
    await devicePage.goto(`${baseUrl}/passpilot/kiosk/simple?school=${SCHOOL_ID}&device=${FIXED_DEVICE.toUpperCase()}`);
    await devicePage.getByTestId("kiosk-claim-code").waitFor();
    assert.equal(
      deviceHeadersSeen.at(-1),
      FIXED_DEVICE,
      "the URL-provided device id must win over the stored random id, normalized lowercase",
    );
    assert.ok(!devicePage.url().includes("device="), "the device param must be stripped from the URL");
    await devicePage.reload();
    await devicePage.getByTestId("kiosk-claim-code").waitFor();
    assert.equal(
      deviceHeadersSeen.at(-1),
      FIXED_DEVICE,
      "the adopted id must persist in localStorage across reload",
    );
    // A malformed ?device= is rejected: the page falls back to the stored id
    // and never persists URL garbage as the device identity.
    await devicePage.goto(`${baseUrl}/passpilot/kiosk/simple?school=${SCHOOL_ID}&device=garbage-not-a-uuid`);
    await devicePage.getByTestId("kiosk-claim-code").waitFor();
    assert.equal(
      deviceHeadersSeen.at(-1),
      FIXED_DEVICE,
      "a malformed device param must fall back to the stored id",
    );
    assert.ok(!devicePage.url().includes("device="), "the malformed param is still stripped");

    // Device memory: a remembered device offers a one-tap teacher resume on
    // the waiting screen, with the claim code kept as the fallback beneath.
    const resumePage = await browser.newPage();
    await resumePage.addInitScript(() => {
      window.localStorage.setItem("pp_kiosk_pin", "1234");
    });
    const resumeDeviceHeaders = [];
    let resumeOutcome = "success"; // flipped to "gone" for the 404 fallback leg
    await resumePage.route("**/api/passpilot/kiosk/**", async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname.endsWith("/auth") || pathname.endsWith("/snapshot")) {
        await route.fulfill({ status: 404, json: { error: "Not found" } });
        return;
      }
      if (pathname.endsWith("/session/resume")) {
        resumeDeviceHeaders.push(request.headers()["x-kiosk-device"] || null);
        if (resumeOutcome === "gone") {
          await route.fulfill({
            status: 404,
            json: { error: "No remembered kiosk.", code: "PASSPILOT_KIOSK_DEVICE_UNKNOWN" },
          });
          return;
        }
        await route.fulfill({
          status: 201,
          json: {
            session: {
              id: "resumed-session",
              status: "active",
              claimCode: null,
              source: "classpilot_groups",
              classId: "class-two",
              gradeId: null,
              className: "Grade 4 Homeroom",
              kioskName: "Mr. Zinkan",
            },
            kioskStyle: "simple",
          },
        });
        return;
      }
      if (pathname.endsWith("/session")) {
        resumeDeviceHeaders.push(request.headers()["x-kiosk-device"] || null);
        await route.fulfill({
          status: 201,
          json: {
            session: { id: "resume-boot-session", status: "unclaimed", claimCode: "777888" },
            kioskStyle: "simple",
            resume: { kioskName: "Mr. Zinkan", className: "Grade 4 Homeroom" },
          },
        });
        return;
      }
      if (pathname.endsWith("/config")) {
        const sessionId = request.headers()["x-kiosk-session"];
        if (sessionId === "resumed-session") {
          await route.fulfill({
            json: {
              session: { id: "resumed-session", status: "active" },
              source: "classpilot_groups",
              classId: "class-two",
              gradeId: null,
              className: "Grade 4 Homeroom",
              kioskName: "Mr. Zinkan",
              kioskEnabled: true,
              kioskRequiresApproval: false,
              defaultPassDuration: 5,
              kioskStyle: "simple",
            },
          });
          return;
        }
        await route.fulfill({
          json: {
            session: { id: "resume-boot-session", status: "unclaimed", claimCode: "777888" },
            source: null,
            classId: null,
            gradeId: null,
            className: null,
            kioskName: null,
            kioskEnabled: true,
            kioskRequiresApproval: false,
            defaultPassDuration: 5,
            kioskStyle: "simple",
          },
        });
        return;
      }
      if (pathname.endsWith("/students")) {
        await route.fulfill({ json: { students: [] } });
        return;
      }
      await route.fulfill({ status: 500, json: { error: "Unexpected kiosk request" } });
    });
    await resumePage.goto(`${baseUrl}/passpilot/kiosk/simple?school=${SCHOOL_ID}`);
    const resumeButton = resumePage.getByTestId("kiosk-resume-button");
    await resumeButton.waitFor();
    assert.match(
      (await resumeButton.textContent()) || "",
      /Resume: Mr\. Zinkan — Grade 4 Homeroom/,
    );
    // The claim code stays available beneath the offer.
    await resumePage.getByTestId("kiosk-claim-code").waitFor();
    await resumePage.getByText("777 888", { exact: true }).waitFor();
    const bootDeviceId = resumeDeviceHeaders.at(-1);
    assert.ok(bootDeviceId, "bootstrap must send X-Kiosk-Device");
    await resumeButton.click();
    // Resumed session renders the active kiosk header for the teacher.
    await resumePage.getByText("Grade 4 Homeroom — Mr. Zinkan", { exact: true }).waitFor();
    assert.equal(
      resumeDeviceHeaders.at(-1),
      bootDeviceId,
      "resume must present the same durable device id as bootstrap",
    );
    // Durability: the device id survives a reload (fallback leg also proves
    // a failed resume clears the button but keeps the claim code).
    resumeOutcome = "gone";
    await resumePage.reload();
    await resumePage.getByTestId("kiosk-resume-button").waitFor();
    assert.equal(resumeDeviceHeaders.at(-1), bootDeviceId, "device id must survive reload");
    await resumePage.getByTestId("kiosk-resume-button").click();
    await resumePage.getByTestId("kiosk-resume-button").waitFor({ state: "detached" });
    await resumePage.getByTestId("kiosk-claim-code").waitFor();
    // Gate mode: the device id deliberately lives in localStorage even while
    // the PIN is sessionStorage-scoped.
    const gateStorage = await gateRedirectPage.evaluate((schoolId) => ({
      deviceInLocal: window.localStorage.getItem(`pp_kiosk_device:${schoolId}`),
      pinInLocal: window.localStorage.getItem("pp_kiosk_pin"),
      pinInSession: window.sessionStorage.getItem("pp_kiosk_pin"),
    }), SCHOOL_ID);
    assert.ok(gateStorage.deviceInLocal, "gate-launched kiosks must persist the device id in localStorage");
    assert.equal(gateStorage.pinInLocal, null, "gate mode must never write the PIN to localStorage");
    assert.equal(gateStorage.pinInSession, "1234");

    await officePage.goto(`${baseUrl}/passpilot/setup`);
    await officePage.waitForURL("**/passpilot/my-class**");

    const assignmentPage = await browser.newPage();
    const assignmentState = freshState({
      adminClasses: officialClasses,
      adminStudents: [
        { id: "student-a", studentName: "Arielle Danner", studentEmail: "adanner@example.edu", gradeLevel: "5", status: "active" },
        { id: "student-b", studentName: "Taylor Student", studentEmail: "taylor@example.edu", gradeLevel: "5", status: "active" },
      ],
    });
    await installApiMocks(assignmentPage, assignmentState);
    await assignmentPage.goto(
      `${baseUrl}/classpilot/admin/classes?assignStudentId=student-a&returnTo=%2Fclasspilot%2Fstudents`,
    );
    const studentACheckbox = assignmentPage.getByTestId("checkbox-student-student-a");
    const studentBCheckbox = assignmentPage.getByTestId("checkbox-student-student-b");
    await studentACheckbox.waitFor();
    await assignmentPage.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "checkbox-student-student-a");
    assert.equal(await studentACheckbox.getAttribute("data-state"), "checked");
    assert.equal(await assignmentPage.getByTestId("button-assign-students").isDisabled(), true, "the administrator must choose a class explicitly");

    await assignmentPage.evaluate(() => {
      window.history.pushState({}, "", "/classpilot/admin/classes?assignStudentId=student-b&returnTo=%2Fclasspilot%2Fstudents");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await assignmentPage.waitForFunction(() => (
      document.querySelector('[data-testid="checkbox-student-student-b"]')?.getAttribute("data-state") === "checked"
      && document.querySelector('[data-testid="checkbox-student-student-a"]')?.getAttribute("data-state") !== "checked"
    ));

    await assignmentPage.getByTestId("select-class").click();
    await assignmentPage.getByRole("option", { name: /Grade 3 Homeroom/ }).click();
    await assignmentPage.getByTestId("button-assign-students").click();
    await assignmentPage.getByText("1 added, 0 already assigned, 0 failed.", { exact: true }).waitFor();
    assert.deepEqual(assignmentState.adminClassAssignments, [{
      classId: "class-one",
      payload: { studentIds: ["student-b"] },
    }]);
    assert.equal(await studentBCheckbox.getAttribute("data-state"), "checked", "the handoff student stays selected for a second class");

    await assignmentPage.getByTestId("select-class").click();
    await assignmentPage.getByRole("option", { name: /Grade 4 Homeroom/ }).click();
    await assignmentPage.getByTestId("button-assign-students").click();
    await assignmentPage.waitForFunction(() => document.body.textContent?.includes("Roster updated"));
    assert.deepEqual(assignmentState.adminClassAssignments.at(-1), {
      classId: "class-two",
      payload: { studentIds: ["student-b"] },
    });

    await assignmentPage.evaluate(() => {
      window.history.pushState({}, "", "/classpilot/admin/classes?assignStudentId=missing-student&returnTo=%2Fclasspilot%2Fstudents");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await assignmentPage.getByText("Student unavailable", { exact: true }).waitFor();
    assert.equal(await studentBCheckbox.getAttribute("data-state"), "unchecked", "an invalid handoff must clear an earlier selection");

    await assignmentPage.evaluate(() => {
      window.history.pushState({}, "", "/classpilot/admin/classes?returnTo=%2Fclasspilot%2Fstudents");
      window.dispatchEvent(new PopStateEvent("popstate"));
      window.history.pushState({}, "", "/classpilot/admin/classes?assignStudentId=student-b&returnTo=%2Fclasspilot%2Fstudents");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await assignmentPage.waitForFunction(() => (
      document.querySelector('[data-testid="checkbox-student-student-b"]')?.getAttribute("data-state") === "checked"
    ));
    assert.equal(await assignmentPage.getByTestId("button-back-student-roster").isVisible(), true);
    await assignmentPage.close();

    const roundTripPage = await browser.newPage();
    await installApiMocks(roundTripPage, freshState());
    await roundTripPage.goto(`${baseUrl}/classpilot/admin/classes?returnTo=%2Fpasspilot%2Fclasses`);
    const backToPassPilot = roundTripPage.getByTestId("button-back-passpilot");
    await backToPassPilot.waitFor();
    await backToPassPilot.click();
    await roundTripPage.waitForURL("**/passpilot/classes");
    await roundTripPage.goto(`${baseUrl}/classpilot/admin/classes?returnTo=https%3A%2F%2Fexample.invalid`);
    assert.equal(await roundTripPage.getByTestId("button-back-passpilot").count(), 0);
  } finally {
    await browser?.close().catch(() => {});
    await server.close().catch(() => {});
  }
});
