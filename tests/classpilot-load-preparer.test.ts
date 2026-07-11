import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  ApiClient,
  FILES,
  REPO_ROOT,
  assertNoStripeBilling,
  assertExternalPaths,
  buildCleanupPlan,
  buildDryRunSummary,
  buildFixtureBlueprint,
  configuredLoadGatesRoot,
  login,
  parseRateLimitDelayMs,
  preparePrivateOutputDirectory,
  revokeDeviceSessionStrict,
  runCli as runPreparerCli,
  selectConfiguredSchool,
  superAdminAuthPrerequisiteReasons,
  superAuthFromEnvironment,
  validateAuthArtifactContract,
  validateConfig,
  validateStateContract,
  verifySchoolSoftDeletePostcondition,
  writePrivateJson,
} from "../scripts/load/prepare-classpilot-load-test.mjs";

const testFile = fileURLToPath(import.meta.url);
const script = join(dirname(testFile), "../scripts/load/prepare-classpilot-load-test.mjs");
let tempRoot = "";
let configPath = "";
let loadGatesRoot = "";

function rawConfig() {
  return {
    version: 1,
    fixtureId: "launch-safe-2026",
    baseUrl: "http://127.0.0.1:48123",
    ownershipAcknowledgement: "TOOL_OWNED_MARKED_NON_BILLABLE_SYNTHETIC_TENANTS_ONLY",
    emailDeliveryAcknowledgement: "ALL_SYNTHETIC_EMAILS_ROUTE_PLUS_ALIASES_TO_OPERATOR_MAILBOX",
    operatorMailboxEmail: "operator@primary-load.example.org",
    operatorOwnedAdminEmail: "operator+load-primary@primary-load.example.org",
    allowSchoolCreation: false,
    cleanupOwnedSchools: false,
    schools: {
      primary: {
        name: "[SYNTHETIC LOAD TEST - NON-BILLABLE] launch-safe-2026 Primary School",
        domain: "primary-load.example.org",
        adminEmail: "operator+load-primary@primary-load.example.org",
      },
      canary: {
        name: "[SYNTHETIC LOAD TEST - NON-BILLABLE] launch-safe-2026 Canary School",
        domain: "primary-load.example.org",
        adminEmail: "operator+load-canary@primary-load.example.org",
      },
    },
    aliases: {
      teacherPrefix: "operator+load-teacher",
      primaryStudentPrefix: "operator+load-student",
      canaryStudentPrefix: "operator+load-canary-student",
    },
    commandUrl: "https://example.edu/schoolpilot-load-test",
    registrationRequestsPerMinute: 600,
  };
}

function cleanEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLP_")) delete env[key];
  }
  return {
    ...env,
    NODE_ENV: "test",
    CLP_LOAD_FIXTURE_TEST_MODE: "1",
    CLP_LOAD_GATES_TEST_ROOT: loadGatesRoot,
    ...overrides,
  };
}

function runCli(args: string[], env: NodeJS.ProcessEnv = cleanEnv()) {
  return spawnSync(process.execPath, [script, ...args], {
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
}

function stateFromBlueprint(config: ReturnType<typeof validateConfig>) {
  const blueprint = buildFixtureBlueprint(config);
  const primarySchool = { ...config.schools.primary, id: "school-primary", createdByTool: true, nonBillableVerifiedAt: new Date().toISOString(), billingProtectionVerified: true };
  const canarySchool = { ...config.schools.canary, id: "school-canary", createdByTool: true, nonBillableVerifiedAt: new Date().toISOString(), billingProtectionVerified: true };
  const primaryStudents = blueprint.primaryStudents.map((student: any) => ({ ...student, id: `primary-${student.ordinal}` }));
  const canaryStudents = blueprint.canaryStudents.map((student: any) => ({ ...student, id: `canary-${student.ordinal}` }));
  const teachers = blueprint.teachers.map((teacher: any) => ({
    ...teacher,
    userId: `teacher-${teacher.ordinal}`,
    membershipId: `membership-${teacher.ordinal}`,
    classId: `class-${teacher.ordinal}`,
    className: blueprint.classes[teacher.ordinal - 1].name,
  }));
  return {
    schemaVersion: 1,
    fixtureId: config.fixtureId,
    baseUrl: config.baseUrl,
    ownershipAcknowledgement: config.ownershipAcknowledgement,
    schools: { primary: primarySchool, canary: canarySchool },
    admin: { email: config.schools.primary.adminEmail, userId: "admin-user-primary" },
    teachers,
    students: { primary: primaryStudents, canary: canaryStudents },
    devices: blueprint.devices.map((device: any) => {
      const students = device.schoolKey === "primary" ? primaryStudents : canaryStudents;
      return {
        ...device,
        studentId: students[device.studentOrdinal - 1].id,
        schoolId: device.schoolKey === "primary" ? primarySchool.id : canarySchool.id,
        classId: device.classOrdinal ? `class-${device.classOrdinal}` : null,
      };
    }),
    sessions: teachers.map((teacher: any) => ({
      sessionId: `session-${teacher.ordinal}`,
      classId: teacher.classId,
      teacherUserId: teacher.userId,
    })),
  };
}

function mockJwt(payload: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.mock-signature`;
}

function authArtifactFromState(config: ReturnType<typeof validateConfig>, state: any, expiresInSeconds = 48 * 60 * 60) {
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const expiresAt = new Date(expiresAtSeconds * 1000).toISOString();
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    baseUrl: config.baseUrl,
    schoolId: state.schools.primary.id,
    role: "school_admin",
    teacherCookie: "schoolpilot.sid=command-admin-session",
    csrfToken: "command-admin-csrf",
    teacherToken: mockJwt({
      exp: expiresAtSeconds,
      userId: state.admin.userId,
      email: state.admin.email,
    }),
    expiresAt,
    deviceManifestExpiresAt: expiresAt,
    teacherAuth: state.teachers.map((teacher: any, index: number) => ({
      teacherId: teacher.userId,
      schoolId: state.schools.primary.id,
      role: "teacher",
      teachingSessionId: state.sessions[index].sessionId,
      teacherCookie: `schoolpilot.sid=teacher-session-${index + 1}`,
      csrfToken: `teacher-csrf-${index + 1}`,
      teacherToken: mockJwt({
        exp: expiresAtSeconds,
        userId: teacher.userId,
        email: teacher.email,
      }),
      expiresAt,
      studentIds: state.devices
        .filter((device: any) => device.schoolKey === "primary" && device.classId === teacher.classId)
        .map((device: any) => device.studentId),
    })),
  };
}

describe("ClassPilot synthetic load fixture preparer", () => {
  it("fails closed if a synthetic tenant has Stripe billing records", () => {
    assert.equal(
      assertNoStripeBilling({ billingEmail: null, stripeCustomerId: null, stripeSubscriptionId: null }),
      true
    );
    assert.throws(
      () => assertNoStripeBilling({ billingEmail: null, stripeCustomerId: "cus_live", stripeSubscriptionId: null }),
      /Stripe billing records/
    );
    assert.throws(
      () => assertNoStripeBilling({ school: { id: "school-primary" }, billing: {} }),
      /response is invalid/
    );
    assert.throws(
      () => assertNoStripeBilling({ billingEmail: "billing@example.org", stripeCustomerId: null }),
      /Stripe billing records/
    );
  });

  it("requires exact absence or the flat super-admin deletedAt terminal state after school cleanup", async () => {
    const config = validateConfig(rawConfig());
    const state = stateFromBlueprint(config);
    const deletedAt = new Date().toISOString();
    const terminalSchool = {
      id: state.schools.primary.id,
      name: config.schools.primary.name,
      domain: config.schools.primary.domain,
      status: "suspended",
      deletedAt,
      billingEmail: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    };
    const terminalClient = {
      request: async (route: string) => route.includes("?status=all")
        ? { status: 200, data: { schools: [] } }
        : { status: 200, data: terminalSchool },
    };
    const terminal: any = await verifySchoolSoftDeletePostcondition(
      terminalClient, { bearer: "super-token" }, config, state, "primary",
    );
    assert.equal(terminal.terminalState, "soft-deleted");
    assert.equal(terminal.deletedAt, deletedAt);

    const absentClient = {
      request: async (route: string) => route.includes("?status=all")
        ? { status: 200, data: { schools: [] } }
        : { status: 404, data: { error: "School not found" } },
    };
    const absent: any = await verifySchoolSoftDeletePostcondition(
      absentClient, { bearer: "super-token" }, config, state, "primary",
    );
    assert.equal(absent.terminalState, "absent");

    const undeletedClient = {
      request: async (route: string) => route.includes("?status=all")
        ? { status: 200, data: { schools: [] } }
        : { status: 200, data: { ...terminalSchool, deletedAt: null } },
    };
    await assert.rejects(
      () => verifySchoolSoftDeletePostcondition(
        undeletedClient, { bearer: "super-token" }, config, state, "primary",
      ),
      /documented deletedAt terminal state/,
    );
  });

  before(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "schoolpilot-classpilot-preparer-"));
    loadGatesRoot = join(tempRoot, "LocalAppData", "SchoolPilot", "load-gates");
    configPath = join(tempRoot, "fixture-config.json");
    writeFileSync(configPath, JSON.stringify(rawConfig()));
  });

  after(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it("builds the exact 10 + 500 + 300 + 200 launch order and disjoint class rosters", () => {
    const config = validateConfig(rawConfig());
    const blueprint = buildFixtureBlueprint(config);
    assert.equal(blueprint.teachers.length, 20);
    assert.equal(blueprint.primaryStudents.length, 1000);
    assert.equal(blueprint.canaryStudents.length, 10);
    assert.equal(blueprint.classes.length, 20);
    assert.equal(blueprint.devices.length, 1010);
    assert.deepEqual(
      [blueprint.devices[0].cohort, blueprint.devices[9].cohort, blueprint.devices[10].cohort,
        blueprint.devices[509].cohort, blueprint.devices[510].cohort, blueprint.devices[809].cohort,
        blueprint.devices[810].cohort, blueprint.devices[1009].cohort],
      ["second-school-canary-10", "second-school-canary-10", "class-first-25", "class-first-25",
        "class-remaining-15", "class-remaining-15", "burst-200", "burst-200"],
    );
    const rosterEmails = blueprint.classes.flatMap((entry: any) => entry.studentEmails);
    assert.equal(rosterEmails.length, 800);
    assert.equal(new Set(rosterEmails).size, 800);
    assert.ok(blueprint.classes.every((entry: any) => entry.studentEmails.length === 40));
    assert.deepEqual(buildDryRunSummary(config).expected.students, {
      primary: 1000,
      canary: 10,
      total: 1010,
      autoEnroll: false,
    });
  });

  it("accepts only the exact schema-v2 command-admin and 20-teacher auth mapping", () => {
    const config = validateConfig(rawConfig());
    const state = stateFromBlueprint(config);
    const validated: any = validateAuthArtifactContract(authArtifactFromState(config, state), config, state);
    assert.equal(validated.teachers.length, 20);
    assert.equal(new Set(validated.teachers.map((entry: any) => entry.teacher.userId)).size, 20);
  });

  it("rejects stale command-admin or teacher authentication artifacts", () => {
    const config = validateConfig(rawConfig());
    const state = stateFromBlueprint(config);
    const staleAdmin = authArtifactFromState(config, state);
    staleAdmin.expiresAt = new Date(Date.now() - 60_000).toISOString();
    assert.throws(
      () => validateAuthArtifactContract(staleAdmin, config, state),
      /artifact expiry is expired/,
    );

    const staleTeacher = authArtifactFromState(config, state);
    staleTeacher.teacherAuth[0].expiresAt = new Date(Date.now() - 60_000).toISOString();
    assert.throws(
      () => validateAuthArtifactContract(staleTeacher, config, state),
      /Teacher auth entry 1 expiry is expired/,
    );
  });

  it("rejects malicious cross-mapped teacher sessions, JWT identities, and class students", () => {
    const config = validateConfig(rawConfig());
    const state = stateFromBlueprint(config);

    const crossedSession = authArtifactFromState(config, state);
    crossedSession.teacherAuth[0].teachingSessionId = crossedSession.teacherAuth[1].teachingSessionId;
    assert.throws(
      () => validateAuthArtifactContract(crossedSession, config, state),
      /exact teacher, class, session, and primary school/,
    );

    const crossedIdentity = authArtifactFromState(config, state);
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + 60 * 60;
    crossedIdentity.teacherAuth[0].teacherToken = mockJwt({
      exp: expiresAtSeconds,
      userId: state.teachers[1].userId,
      email: state.teachers[1].email,
    });
    assert.throws(
      () => validateAuthArtifactContract(crossedIdentity, config, state),
      /does not match its exact fixture identity/,
    );

    const crossedStudents = authArtifactFromState(config, state);
    crossedStudents.teacherAuth[0].studentIds = [...crossedStudents.teacherAuth[1].studentIds];
    assert.throws(
      () => validateAuthArtifactContract(crossedStudents, config, state),
      /exact 40-student class mapping/,
    );
  });

  it("supports two exact synthetic schools through verified plus aliases on one Gmail domain", () => {
    const value = rawConfig();
    value.operatorMailboxEmail = "bzinkan@school-pilot.net";
    value.operatorOwnedAdminEmail = "bzinkan+launch-primary@school-pilot.net";
    value.schools.primary.domain = "school-pilot.net";
    value.schools.primary.adminEmail = "bzinkan+launch-primary@school-pilot.net";
    value.schools.canary.domain = "school-pilot.net";
    value.schools.canary.adminEmail = "bzinkan+launch-canary@school-pilot.net";
    value.aliases = {
      teacherPrefix: "bzinkan+launch-teacher",
      primaryStudentPrefix: "bzinkan+launch-student",
      canaryStudentPrefix: "bzinkan+launch-canary-student",
    };
    const config = validateConfig(value);
    const blueprint = buildFixtureBlueprint(config);
    assert.equal(config.operatorMailboxEmail, "bzinkan@school-pilot.net");
    assert.ok(blueprint.teachers.every((teacher: any) => teacher.email.startsWith("bzinkan+launch-teacher-")));
    assert.ok(blueprint.primaryStudents.every((student: any) => student.email.endsWith("@school-pilot.net")));
    assert.ok(blueprint.canaryStudents.every((student: any) => student.email.endsWith("@school-pilot.net")));

    const missingAcknowledgement = structuredClone(value);
    delete missingAcknowledgement.emailDeliveryAcknowledgement;
    assert.throws(() => validateConfig(missingAcknowledgement), /emailDeliveryAcknowledgement/);
    assert.throws(
      () => validateConfig({ ...value, schools: { ...value.schools, canary: { ...value.schools.canary, adminEmail: "someone+launch-canary@school-pilot.net" } } }),
      /plus alias of operatorMailboxEmail/,
    );
    assert.throws(
      () => validateConfig({ ...value, schools: { ...value.schools, canary: { ...value.schools.canary, adminEmail: value.schools.primary.adminEmail } } }),
      /different verified admin aliases/,
    );
    assert.throws(
      () => validateConfig({ ...value, aliases: { ...value.aliases, teacherPrefix: "launch-teacher" } }),
      /plus alias prefix of operatorMailboxEmail/,
    );
    assert.throws(
      () => validateConfig({ ...value, schools: { ...value.schools, primary: { ...value.schools.primary, name: "launch-safe-2026 Primary School" } } }),
      /literal non-billable synthetic marker/,
    );
  });

  it("selects shared-domain schools by exact domain plus name", () => {
    const config = validateConfig({
      ...rawConfig(),
      schools: {
        primary: { ...rawConfig().schools.primary, domain: "primary-load.example.org" },
        canary: {
          ...rawConfig().schools.canary,
          domain: "primary-load.example.org",
          adminEmail: "operator+load-canary@primary-load.example.org",
        },
      },
    });
    const schools = [
      { id: "unrelated", name: "Existing Real School", domain: config.schools.primary.domain },
      { id: "primary", name: config.schools.primary.name, domain: config.schools.primary.domain },
      { id: "canary", name: config.schools.canary.name, domain: config.schools.canary.domain },
    ];
    assert.equal(selectConfiguredSchool(schools, config.schools.primary, "primary")?.id, "primary");
    assert.equal(selectConfiguredSchool(schools, config.schools.canary, "canary")?.id, "canary");
    assert.equal(selectConfiguredSchool(schools, { ...config.schools.canary, name: "missing" }, "canary"), null);
  });

  it("prints secret-free help without requiring config or output paths", () => {
    const result = runCli(["--help"], cleanEnv({
      CLP_SUPER_ADMIN_BEARER: "help-bearer-secret-sentinel",
      CLP_SUPER_ADMIN_PASSWORD: "help-super-secret-sentinel",
      CLP_FIXTURE_ADMIN_PASSWORD: "help-admin-secret-sentinel",
    }));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Commands:/);
    assert.match(result.stdout, /emailDeliveryAcknowledgement/);
    assert.match(result.stdout, /operatorMailboxEmail/);
    assert.match(result.stdout, /CLP_CANARY_ALIAS_CONFIRMED=<fixtureId>/);
    assert.match(result.stdout, /CLP_SUPER_ADMIN_BEARER/);
    assert.match(result.stdout, /verified through \/api\/auth\/me/);
    assert.match(result.stdout, /may safely share the base mailbox domain/);
    assert.match(result.stdout, /Existing schools are accepted only with the matching private tool-ownership ledger/);
    assert.doesNotMatch(result.stdout, /help-bearer-secret-sentinel|help-super-secret-sentinel|help-admin-secret-sentinel/);
  });

  it("accepts a bearer only after exact super-admin /auth/me identity verification", async () => {
    const config = validateConfig(rawConfig());
    const bearer = "bearer-success-secret-sentinel";
    const calls: Array<{ route: string; options: any }> = [];
    const client = {
      request: async (route: string, options: any) => {
        calls.push({ route, options });
        return {
          status: 200,
          data: { user: { id: "super-user", email: config.operatorMailboxEmail.toUpperCase(), isSuperAdmin: true } },
        };
      },
    };
    const auth = await superAuthFromEnvironment(client, config, {
      CLP_SUPER_ADMIN_BEARER: bearer,
    } as NodeJS.ProcessEnv);
    assert.deepEqual(auth, { bearer });
    assert.deepEqual(calls, [{ route: "/api/auth/me", options: { bearer } }]);
  });

  it("rejects bearer identities with the wrong role or operator mailbox without leaking the token", async () => {
    const config = validateConfig(rawConfig());
    const bearer = "bearer-rejection-secret-sentinel";
    const verify = async (user: Record<string, unknown>) => {
      const client = { request: async () => ({ status: 200, data: { user } }) };
      let caught: unknown;
      try {
        await superAuthFromEnvironment(client, config, { CLP_SUPER_ADMIN_BEARER: bearer } as NodeJS.ProcessEnv);
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof Error);
      assert.doesNotMatch(String(caught), /bearer-rejection-secret-sentinel/);
      return String(caught);
    };
    assert.match(await verify({ id: "ordinary-user", email: config.operatorMailboxEmail, isSuperAdmin: false }), /does not belong to a super administrator/);
    assert.match(await verify({ id: "other-super", email: "other@example.org", isSuperAdmin: true }), /different operator mailbox identity/);
  });

  it("preserves password authentication while requiring one complete super-admin auth mode", async () => {
    const config = validateConfig(rawConfig());
    assert.deepEqual(superAdminAuthPrerequisiteReasons({} as NodeJS.ProcessEnv), [
      "CLP_SUPER_ADMIN_BEARER or CLP_SUPER_ADMIN_EMAIL is absent from the current process",
      "CLP_SUPER_ADMIN_BEARER or CLP_SUPER_ADMIN_PASSWORD is absent from the current process",
    ]);
    await assert.rejects(
      () => superAuthFromEnvironment({ request: async () => assert.fail("network must not be called") }, config, {} as NodeJS.ProcessEnv),
      /CLP_SUPER_ADMIN_BEARER or CLP_SUPER_ADMIN_EMAIL/,
    );

    const calls: Array<{ route: string; options: any }> = [];
    const client = {
      request: async (route: string, options: any) => {
        calls.push({ route, options });
        if (route === "/api/auth/login") {
          return {
            status: 200,
            headers: new Headers({ "set-cookie": "schoolpilot.sid=password-session; Path=/; HttpOnly" }),
            data: { token: "password-mode-token", user: { id: "super-user" }, memberships: [] },
          };
        }
        return {
          status: 200,
          data: { user: { id: "super-user", email: config.operatorMailboxEmail, isSuperAdmin: true } },
        };
      },
    };
    const auth = await superAuthFromEnvironment(client, config, {
      CLP_SUPER_ADMIN_EMAIL: config.operatorMailboxEmail,
      CLP_SUPER_ADMIN_PASSWORD: "password-mode-secret-sentinel",
    } as NodeJS.ProcessEnv);
    assert.deepEqual(auth, { bearer: "password-mode-token" });
    assert.equal(calls[0].options.body.password, "password-mode-secret-sentinel");
    assert.deepEqual(calls[1], { route: "/api/auth/me", options: { bearer: "password-mode-token" } });
  });

  it("rejects config-embedded secrets and any config or output path under the repository", () => {
    assert.throws(
      () => validateConfig({ ...rawConfig(), adminPassword: "must-not-live-in-config" }),
      /must not contain credential or token fields/,
    );
    assert.throws(() => assertExternalPaths(testFile, tempRoot, REPO_ROOT, loadGatesRoot), /outside the SchoolPilot repository/);
    assert.throws(() => assertExternalPaths(configPath, join(REPO_ROOT, ".load-output"), REPO_ROOT, loadGatesRoot), /outside the SchoolPilot repository/);
    assert.throws(() => assertExternalPaths(configPath, join(tempRoot, "external-output"), REPO_ROOT, loadGatesRoot), /LOCALAPPDATA/);
    assert.doesNotThrow(() => assertExternalPaths(configPath, join(loadGatesRoot, "fixture-output"), REPO_ROOT, loadGatesRoot));
    assert.throws(
      () => configuredLoadGatesRoot({ NODE_ENV: "test", CLP_LOAD_GATES_TEST_ROOT: loadGatesRoot } as NodeJS.ProcessEnv),
      /requires NODE_ENV=test and CLP_LOAD_FIXTURE_TEST_MODE=1/,
    );
    assert.throws(
      () => configuredLoadGatesRoot({ CLP_LOAD_FIXTURE_TEST_MODE: "1", CLP_LOAD_GATES_TEST_ROOT: loadGatesRoot } as NodeJS.ProcessEnv),
      /requires NODE_ENV=test and CLP_LOAD_FIXTURE_TEST_MODE=1/,
    );
  });

  it("writes private JSON atomically and replaces only the named artifact", () => {
    const output = preparePrivateOutputDirectory(join(loadGatesRoot, "atomic-output"), loadGatesRoot);
    writePrivateJson(output, "artifact.private.json", { generation: 1 });
    writePrivateJson(output, "artifact.private.json", { generation: 2 });
    assert.deepEqual(JSON.parse(readFileSync(join(output, "artifact.private.json"), "utf8")), { generation: 2 });
    assert.deepEqual(readdirSync(output), ["artifact.private.json"]);
  });

  it("honors retry and standardized rate-limit reset headers", async () => {
    assert.equal(parseRateLimitDelayMs(new Headers({ "retry-after": "7" }), 1_000), 7_000);
    assert.equal(parseRateLimitDelayMs(new Headers({ ratelimit: '"default";r=0;t=9, limit=15, remaining=0, reset=9' }), 1_000), 9_000);
    assert.equal(parseRateLimitDelayMs(new Headers({ ratelimit: '"login";r=1;t=9' }), 1_000), null);
    assert.equal(parseRateLimitDelayMs(new Headers({ ratelimit: '"login";r=1;t=9' }), 1_000, 1), 9_000);
    assert.equal(parseRateLimitDelayMs(new Headers({ "ratelimit-remaining": "0", "ratelimit-reset": "12" }), 1_000), 12_000);

    let now = 0;
    let calls = 0;
    const sleeps: number[] = [];
    const client = new ApiClient("http://127.0.0.1:48123", {
      now: () => now,
      sleepFn: async (ms: number) => { sleeps.push(ms); now += ms; },
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "0" } })
          : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const response = await client.request("/api/test");
    assert.equal(response.data.ok, true);
    assert.equal(calls, 2);
    assert.ok(sleeps.reduce((sum, value) => sum + value, 0) >= 250);
  });

  it("waits after fourteen logins without delaying unrelated APIs that report one remaining request", async () => {
    const windowMs = 15 * 60_000;
    let now = 0;
    let windowStart = 0;
    let loginsInWindow = 0;
    const loginTimes: number[] = [];
    const sleeps: number[] = [];
    const client = new ApiClient("http://127.0.0.1:48123", {
      now: () => now,
      sleepFn: async (ms: number) => { sleeps.push(ms); now += ms; },
      fetchImpl: async (input: URL | RequestInfo) => {
        const url = new URL(String(input));
        if (url.pathname !== "/api/auth/login") {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json", ratelimit: '"shared-shape";r=1;t=900' },
          });
        }
        if (now - windowStart >= windowMs) {
          windowStart = now;
          loginsInWindow = 0;
        }
        loginsInWindow += 1;
        loginTimes.push(now);
        const remaining = 15 - loginsInWindow;
        const resetSeconds = Math.ceil((windowStart + windowMs - now) / 1000);
        return new Response(JSON.stringify({ token: "header.payload.signature", user: { id: "fixture-user" }, memberships: [] }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "schoolpilot.sid=fixture-session; Path=/; HttpOnly",
            ratelimit: `"login";r=${remaining};t=${resetSeconds}`,
          },
        });
      },
    });

    for (let index = 0; index < 14; index += 1) await login(client, `teacher-${index}@example.org`, "fixture-password");
    assert.equal(loginTimes.filter((time) => time < windowMs).length, 14);
    const beforeUnrelated = now;
    await client.request("/api/unrelated");
    await client.request("/api/unrelated-again");
    assert.equal(now, beforeUnrelated, "login safety margin must not globally delay unrelated APIs");

    for (let index = 14; index < 20; index += 1) await login(client, `teacher-${index}@example.org`, "fixture-password");
    assert.equal(loginTimes.length, 20);
    assert.equal(loginTimes.filter((time) => time < windowMs).length, 14, "a fifteenth login must not be sent in the first window");
    assert.ok(loginTimes[14] >= windowMs);
    assert.ok(sleeps.some((duration) => duration >= windowMs));
  });

  it("proves exact cookie membership context and automatically scopes subsequent bearer requests", async () => {
    const seen: Array<{ path: string; schoolId: string | undefined }> = [];
    const client = new ApiClient("http://127.0.0.1:48123", {
      fetchImpl: async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        seen.push({ path: url.pathname, schoolId: headers.get("x-school-id") || undefined });
        if (url.pathname === "/api/auth/login") {
          return new Response(JSON.stringify({
            token: "login.token.signature",
            user: { id: "teacher-user" },
            memberships: [{ id: "membership", schoolId: "school-primary", schoolName: "Fixture Primary", role: "teacher" }],
          }), { status: 200, headers: { "content-type": "application/json", "set-cookie": "schoolpilot.sid=verified-session; Path=/; HttpOnly" } });
        }
        if (url.pathname === "/api/auth/me") {
          assert.equal(headers.get("x-school-id"), "school-primary");
          assert.match(headers.get("cookie") || "", /schoolpilot\.sid=verified-session/);
          return new Response(JSON.stringify({
            token: "verified.token.signature",
            user: { id: "teacher-user" },
            memberships: [{ id: "membership", schoolId: "school-primary", schoolName: "Fixture Primary", role: "teacher" }],
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const auth = await login(client, "teacher@example.org", "fixture-password", {
      schoolId: "school-primary", schoolName: "Fixture Primary", role: "teacher",
    });
    assert.equal(auth.sessionVerified, true);
    await client.request("/api/classpilot/teaching-sessions/start", { method: "POST", bearer: auth.bearer, body: { groupId: "class" } });
    assert.deepEqual(seen.map((entry) => entry.schoolId), [undefined, "school-primary", "school-primary"]);

    await assert.rejects(
      () => login(new ApiClient("http://127.0.0.1:48123", {
        fetchImpl: async () => new Response(JSON.stringify({
          token: "bad.token.signature",
          user: { id: "teacher-user" },
          memberships: [{ schoolId: "wrong-school", schoolName: "Wrong", role: "teacher" }],
        }), { status: 200, headers: { "content-type": "application/json", "set-cookie": "schoolpilot.sid=bad; Path=/" } }),
      }), "teacher@example.org", "fixture-password", { schoolId: "school-primary", schoolName: "Fixture Primary", role: "teacher" }),
      /exact synthetic school and role/,
    );
  });

  it("never accepts a 401 as revocation and replaces the token before requiring explicit sign-out success", async () => {
    const calls: Array<{ route: string; options: any }> = [];
    const client = {
      request: async (route: string, options: any) => {
        calls.push({ route, options });
        if (calls.length === 1) return { status: 401, data: { error: "expired" } };
        if (route.endsWith("/register")) return { status: 200, data: { studentToken: "replacement-token" } };
        return { status: 200, data: { success: true } };
      },
    };
    const result = await revokeDeviceSessionStrict(
      client,
      { studentToken: "expired-token" },
      { deviceId: "fixture-device", studentEmail: "student@example.org", schoolId: "school", schoolKey: "primary", classId: "class" },
      "enrollment-key",
      { wait: async () => {} },
    );
    assert.deepEqual(result, { revoked: true, replacementIssued: true });
    assert.deepEqual(calls.map((entry) => entry.route), [
      "/api/classpilot/extension/sign-out",
      "/api/classpilot/extension/register",
      "/api/classpilot/extension/sign-out",
    ]);
    assert.equal(calls[2].options.bearer, "replacement-token");
  });

  it("fails closed with a precise prerequisite manifest before any network call", () => {
    const output = join(loadGatesRoot, "missing-prerequisites-output");
    const result = runCli(["provision", "--config", configPath, "--output", output], cleanEnv({
      CLP_SUPER_ADMIN_PASSWORD: "super-secret-sentinel",
      CLP_FIXTURE_TEACHER_PASSWORD: "teacher-secret-sentinel",
    }));
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /prerequisites\.private\.json/);
    assert.doesNotMatch(combined, /super-secret-sentinel|teacher-secret-sentinel/);
    const manifest = JSON.parse(readFileSync(join(output, FILES.prerequisites), "utf8"));
    assert.equal(manifest.directDatabaseChangesPermitted, false);
    assert.ok(manifest.reasons.some((reason: string) => reason.includes("CLP_SUPER_ADMIN_EMAIL")));
    assert.ok(manifest.reasons.some((reason: string) => reason.includes("CLP_FIXTURE_ADMIN_PASSWORD")));

    const bearerOutput = join(loadGatesRoot, "missing-fixture-password-with-bearer-output");
    const bearerResult = runCli(["provision", "--config", configPath, "--output", bearerOutput], cleanEnv({
      CLP_SUPER_ADMIN_BEARER: "preflight-bearer-secret-sentinel",
      CLP_FIXTURE_TEACHER_PASSWORD: "teacher-secret-sentinel",
    }));
    const bearerCombined = `${bearerResult.stdout}\n${bearerResult.stderr}\n${readFileSync(join(bearerOutput, FILES.prerequisites), "utf8")}`;
    assert.notEqual(bearerResult.status, 0);
    assert.doesNotMatch(bearerCombined, /preflight-bearer-secret-sentinel|teacher-secret-sentinel/);
    const bearerManifest = JSON.parse(readFileSync(join(bearerOutput, FILES.prerequisites), "utf8"));
    assert.ok(bearerManifest.reasons.some((reason: string) => reason.includes("CLP_FIXTURE_ADMIN_PASSWORD")));
    assert.ok(!bearerManifest.reasons.some((reason: string) => reason.includes("CLP_SUPER_ADMIN_EMAIL is absent")));
  });

  it("verifies primary delivery before creation and preserves ownership across the pre-canary delivery gate", async () => {
    let primarySchool: any = null;
    let dropFirstCreateResponse = true;
    let primaryAdminCreated = false;
    let primarySettingsCreated = false;
    let classPilotEnabled = false;
    let adminRepairCalls = 0;
    let settingsRepairCalls = 0;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        response.writeHead(status, { "content-type": "application/json", ...headers });
        response.end(JSON.stringify(body));
      };
      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        const isSuper = body.email === config.operatorMailboxEmail;
        if (!isSuper) assert.equal(primaryAdminCreated, true);
        return send(200, {
          token: "header.payload.signature",
          user: { id: isSuper ? "super-user" : "user" },
          memberships: [{
            id: "primary-admin-membership",
            schoolId: "school-primary-created",
            schoolName: "[SYNTHETIC LOAD TEST - NON-BILLABLE] launch-safe-2026 Primary School",
            role: "admin",
          }],
        }, {
          "set-cookie": "schoolpilot.sid=mock-session; Path=/; HttpOnly",
        });
      }
      if (request.method === "GET" && url.pathname === "/api/auth/me") {
        if (!request.headers["x-school-id"]) {
          assert.equal(request.headers.authorization, "Bearer header.payload.signature");
          return send(200, {
            token: "verified.super.signature",
            user: { id: "super-user", email: config.operatorMailboxEmail, isSuperAdmin: true },
            memberships: [],
          });
        }
        assert.equal(request.headers["x-school-id"], "school-primary-created");
        return send(200, {
          token: "verified.header.signature",
          user: { id: "user" },
          memberships: [{
            id: "primary-admin-membership",
            schoolId: "school-primary-created",
            schoolName: "[SYNTHETIC LOAD TEST - NON-BILLABLE] launch-safe-2026 Primary School",
            role: "admin",
          }],
        });
      }
      if (request.method === "GET" && url.pathname === "/api/super-admin/schools") {
        return send(200, { schools: primarySchool ? [primarySchool] : [] });
      }
      if (request.method === "POST" && url.pathname === "/api/super-admin/schools") {
        primarySchool = {
          id: "school-primary-created",
          name: "[SYNTHETIC LOAD TEST - NON-BILLABLE] launch-safe-2026 Primary School",
          domain: "primary-load.example.org",
          status: "active",
          billingEmail: null,
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          maxStudents: 1200,
          deletedAt: null,
        };
        if (dropFirstCreateResponse) {
          dropFirstCreateResponse = false;
          request.socket.destroy();
          return;
        }
        return send(201, { school: primarySchool });
      }
      if (request.method === "GET" && url.pathname === "/api/super-admin/schools/school-primary-created") {
        const admin = {
          id: "primary-admin-membership",
          userId: "user",
          role: "admin",
          email: config.schools.primary.adminEmail,
          displayName: "Load Fixture Admin",
        };
        return send(200, {
          ...primarySchool,
          products: classPilotEnabled ? ["CLASSPILOT"] : [],
          admins: primaryAdminCreated ? [admin] : [],
          teachers: [],
          staff: primaryAdminCreated ? [admin] : [],
          studentCount: 0,
          schoolHours: { enabled: false, timezone: "America/New_York" },
        });
      }
      if (request.method === "POST" && url.pathname === "/api/super-admin/schools/school-primary-created/admins") {
        assert.equal(body.email, config.schools.primary.adminEmail);
        assert.equal(body.password, "fixture-admin-password");
        primaryAdminCreated = true;
        adminRepairCalls += 1;
        return send(201, {
          user: { id: "user", email: config.schools.primary.adminEmail },
          tempPassword: "fixture-admin-password",
        });
      }
      if (request.method === "PATCH" && url.pathname === "/api/super-admin/schools/school-primary-created") {
        assert.equal(body.schoolHours?.enabled, false);
        primarySettingsCreated = true;
        settingsRepairCalls += 1;
        return send(200, { school: primarySchool });
      }
      if (request.method === "POST" && url.pathname === "/api/super-admin/schools/school-primary-created/products") {
        classPilotEnabled = true;
        return send(201, { license: { schoolId: primarySchool.id, product: "CLASSPILOT", status: "active" } });
      }
      if (request.method === "GET" && url.pathname === "/api/super-admin/schools/school-primary-created/billing") {
        return send(200, { billingEmail: null, stripeCustomerId: null, stripeSubscriptionId: null });
      }
      return send(404, { error: "mock route missing" });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const config = { ...rawConfig(), baseUrl: `http://127.0.0.1:${address.port}`, allowSchoolCreation: true };
    const localConfigPath = join(tempRoot, "alias-gate-config.json");
    const output = join(loadGatesRoot, "alias-gate-output");
    writeFileSync(localConfigPath, JSON.stringify(config));
    const saved = { ...process.env };
    Object.assign(process.env, cleanEnv({
      CLP_SUPER_ADMIN_EMAIL: config.operatorMailboxEmail,
      CLP_SUPER_ADMIN_PASSWORD: "super-password",
      CLP_FIXTURE_ADMIN_PASSWORD: "fixture-admin-password",
      CLP_FIXTURE_TEACHER_PASSWORD: "fixture-teacher-password",
    }));
    process.env.CLP_OPERATOR_ALIAS_CONFIRMED = "launch-safe-2026";
    delete process.env.CLP_CANARY_ALIAS_CONFIRMED;
    try {
      await assert.rejects(
        () => runPreparerCli(["provision", "--config", localConfigPath, "--output", output]),
        /Network request failed/,
      );
      const pending = JSON.parse(readFileSync(join(output, FILES.ownership), "utf8"));
      assert.equal(pending.schools.primary, undefined);
      assert.equal(pending.pendingCreateIntents.schools.primary.name, config.schools.primary.name);
      await assert.rejects(
        () => runPreparerCli(["provision", "--config", localConfigPath, "--output", output]),
        /prerequisites\.private\.json/,
      );
      const reconciled = JSON.parse(readFileSync(join(output, FILES.ownership), "utf8"));
      assert.equal(reconciled.schools.primary.createdByTool, true);
      assert.equal(reconciled.schools.primary.id, "school-primary-created");
      assert.equal(reconciled.pendingCreateIntents.schools.primary, undefined);
      assert.equal(primaryAdminCreated, true);
      assert.equal(primarySettingsCreated, true);
      assert.equal(adminRepairCalls, 1);
      assert.equal(settingsRepairCalls, 1);
      const prerequisite = JSON.parse(readFileSync(join(output, FILES.prerequisites), "utf8"));
      assert.ok(prerequisite.reasons.some((reason: string) => reason.includes("CLP_CANARY_ALIAS_CONFIRMED")));
      await assert.rejects(
        () => runPreparerCli(["provision", "--config", localConfigPath, "--output", output]),
        /prerequisites\.private\.json/,
      );
      const durable = JSON.parse(readFileSync(join(output, FILES.ownership), "utf8"));
      assert.equal(durable.schools.primary.createdByTool, true);
      assert.equal(adminRepairCalls, 1, "durably owned reruns must not re-enter checkpoint repair");
      await assert.rejects(
        () => runPreparerCli(["provision", "--config", localConfigPath, "--output", join(loadGatesRoot, "foreign-existing-school-output")]),
        /Refusing to adopt an existing primary school/,
      );
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("dry-runs with counts only and never prints process-only credentials", () => {
    const output = join(loadGatesRoot, "dry-run-output");
    const result = runCli(["provision", "--dry-run", "--config", configPath, "--output", output], cleanEnv({
      CLP_SUPER_ADMIN_EMAIL: "operator-secret-sentinel@example.org",
      CLP_SUPER_ADMIN_PASSWORD: "super-password-sentinel",
      CLP_FIXTURE_ADMIN_PASSWORD: "admin-password-sentinel",
      CLP_FIXTURE_TEACHER_PASSWORD: "teacher-password-sentinel",
    }));
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.mutationsPerformed, 0);
    assert.equal(summary.expected.deviceTokens, 1010);
    assert.equal(summary.expected.commandBodies, 20);
    assert.ok(summary.requiredEnvironment.includes("CLP_CANARY_ALIAS_CONFIRMED=launch-safe-2026"));
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /secret-sentinel|password-sentinel/);
    assert.deepEqual(readdirSync(output), []);
  });

  it("validates state order and produces a zero-mutation cleanup dry-run", () => {
    const config = validateConfig(rawConfig());
    const state = stateFromBlueprint(config);
    assert.equal(validateStateContract(state, config), state);
    const reordered = structuredClone(state);
    [reordered.devices[10], reordered.devices[11]] = [reordered.devices[11], reordered.devices[10]];
    assert.throws(() => validateStateContract(reordered, config), /device ordering/);
    const missingStudentMarker = structuredClone(state);
    missingStudentMarker.students.primary[0].studentIdNumber = null;
    assert.throws(() => validateStateContract(missingStudentMarker, config), /student identity/);
    const wrongTeacherMarker = structuredClone(state);
    wrongTeacherMarker.teachers[0].name = "Unmarked Teacher";
    assert.throws(() => validateStateContract(wrongTeacherMarker, config), /teacher identity/);
    const plan = buildCleanupPlan(config, state, 1010);
    assert.equal(plan.mutationsPerformed, 0);
    assert.deepEqual(plan.planned, {
      deviceSignOuts: 1010,
      teachingSessionEnds: 20,
      classArchives: 20,
      tenantTelemetryAndDevicePurges: 2,
      enrollmentKeyRotations: 2,
      classpilotLicenseDisables: 2,
      schoolSuspensions: 2,
      schoolSoftDeletes: 0,
      teacherMembershipDeletes: 20,
      studentDeletes: 1010,
      localCredentialArtifactsRevoked: 3,
    });
  });

  it("refuses to provision over an existing state that does not match the config", () => {
    const output = preparePrivateOutputDirectory(join(loadGatesRoot, "mismatched-state-output"), loadGatesRoot);
    const config = validateConfig(rawConfig());
    const mismatched = { ...stateFromBlueprint(config), fixtureId: "different-fixture" };
    writePrivateJson(output, FILES.state, mismatched);
    const result = runCli(["provision", "--config", configPath, "--output", output]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Fixture state does not match the current config/);
  });

  it("converges a fully mocked provision, schema-v2 harness preflight, deactivation checkpoint, and held cleanup", async () => {
    const configValue = {
      ...rawConfig(),
      allowSchoolCreation: true,
      cleanupOwnedSchools: true,
    };
    const model: any = {
      schools: {},
      staff: { primary: [], canary: [] },
      students: { primary: [], canary: [] },
      classes: new Map<string, any>(),
      rosters: new Map<string, Set<string>>(),
      devices: { primary: new Map<string, any>(), canary: new Map<string, any>() },
      sessions: new Map<string, any>(),
      enrollment: {
        primary: { key: ["enrollment", "primary", "1"].join("-"), generation: 1, autoEnrollStudents: false },
        canary: { key: ["enrollment", "canary", "1"].join("-"), generation: 1, autoEnrollStudents: false },
      },
      events: [] as string[],
      studentImportBatchSizes: [] as number[],
      tokenEmails: new Map<string, string>(),
      tokenCounter: 0,
      teacherCounter: 0,
      classCounter: 0,
      sessionCounter: 0,
      dropFirstTeacherResponse: true,
      dropFirstSignOutResponse: false,
      deletedSchools: new Set<string>(),
    };
    const readBody = async (request: import("node:http").IncomingMessage) => {
      const chunks: Buffer[] = [];
      for await (const value of request) chunks.push(Buffer.from(value));
      return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    };
    const schoolKeyForId = (schoolId: string) => Object.keys(model.schools)
      .find((key) => model.schools[key]?.id === schoolId) as "primary" | "canary" | undefined;
    const identityForEmail = (email: string) => {
      for (const schoolKey of ["primary", "canary"] as const) {
        const entry = model.staff[schoolKey].find((candidate: any) => candidate.user.email === email);
        if (entry) return { schoolKey, entry };
      }
      return null;
    };
    const issueToken = (email: string, payload: Record<string, unknown> = {}) => {
      const token = mockJwt({ exp: Math.floor(Date.now() / 1000) + 48 * 60 * 60, email, nonce: ++model.tokenCounter, ...payload });
      model.tokenEmails.set(token, email);
      return token;
    };
    const server = createServer(async (request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        response.writeHead(status, { "content-type": "application/json", ...headers });
        response.end(JSON.stringify(body));
      };
      try {
        if (request.method === "POST" && url.pathname === "/api/auth/login") {
          const body = await readBody(request);
          const identity = identityForEmail(body.email);
          const isSuper = body.email === configValue.operatorMailboxEmail;
          if (!identity && !isSuper) return send(401, { error: "invalid" });
          const userId = isSuper ? "super-user" : identity!.entry.userId;
          const memberships = isSuper ? [] : [{
            id: identity!.entry.membershipId,
            schoolId: model.schools[identity!.schoolKey].id,
            schoolName: model.schools[identity!.schoolKey].name,
            role: identity!.entry.role === "school_admin" ? "admin" : identity!.entry.role,
          }];
          return send(200, { token: issueToken(body.email, { userId }), user: { id: userId, email: body.email }, memberships }, {
            "set-cookie": `schoolpilot.sid=${Buffer.from(body.email).toString("base64url")}; Path=/; HttpOnly`,
          });
        }
        if (request.method === "GET" && url.pathname === "/api/auth/me") {
          const encoded = /schoolpilot\.sid=([^;]+)/.exec(String(request.headers.cookie || ""))?.[1] || "";
          const cookieEmail = Buffer.from(encoded, "base64url").toString("utf8");
          const authToken = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
          const email = cookieEmail || model.tokenEmails.get(authToken) || "";
          if (email === configValue.operatorMailboxEmail) {
            if (request.headers["x-school-id"]) return send(403, { error: "super identity must not be tenant-bound" });
            return send(200, {
              token: issueToken(email, { userId: "super-user" }),
              user: { id: "super-user", email, isSuperAdmin: true },
              memberships: [],
            });
          }
          const identity = identityForEmail(email);
          if (!identity) return send(401, { error: "invalid session" });
          const school = model.schools[identity.schoolKey];
          if (request.headers["x-school-id"] !== school.id) return send(403, { error: "wrong school context" });
          return send(200, {
            token: issueToken(email, { userId: identity.entry.userId }),
            user: { id: identity.entry.userId, email },
            memberships: [{
              id: identity.entry.membershipId,
              schoolId: school.id,
              schoolName: school.name,
              role: identity.entry.role === "school_admin" ? "admin" : identity.entry.role,
            }],
          });
        }
        if (request.method === "GET" && url.pathname === "/api/auth/csrf") {
          if (!request.headers["x-school-id"]) return send(400, { error: "missing school" });
          return send(200, { csrfToken: `csrf-${request.headers["x-school-id"]}` });
        }

        const bearer = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
        const bearerEmail = model.tokenEmails.get(bearer) || "";
        const isSuper = bearerEmail === configValue.operatorMailboxEmail;
        if (url.pathname === "/api/super-admin/schools" && request.method === "GET") {
          return send(200, { schools: Object.values(model.schools).filter((school: any) => !school.deleted) });
        }
        if (url.pathname === "/api/super-admin/schools" && request.method === "POST") {
          if (!isSuper) return send(403, { error: "super only" });
          const body = await readBody(request);
          const schoolKey: "primary" | "canary" = body.name.includes("Primary") ? "primary" : "canary";
          const school = {
            id: `school-${schoolKey}`,
            name: body.name,
            domain: body.domain,
            status: "active",
            billingEmail: null,
            stripeCustomerId: null,
            stripeSubscriptionId: null,
            products: new Set<string>(),
            trackingEnabled: true,
            deleted: false,
          };
          model.schools[schoolKey] = school;
          model.staff[schoolKey] = [{
            membershipId: `admin-membership-${schoolKey}`,
            userId: `admin-user-${schoolKey}`,
            role: "school_admin",
            user: { id: `admin-user-${schoolKey}`, email: body.adminEmail, displayName: `${schoolKey} fixture admin` },
          }];
          model.events.push(`school-created:${schoolKey}`);
          return send(201, { school: { ...school, products: undefined } });
        }
        const superSchoolMatch = /^\/api\/super-admin\/schools\/([^/]+)$/.exec(url.pathname);
        const superProductMatch = /^\/api\/super-admin\/schools\/([^/]+)\/products(?:\/CLASSPILOT)?$/.exec(url.pathname);
        const superBillingMatch = /^\/api\/super-admin\/schools\/([^/]+)\/billing$/.exec(url.pathname);
        const superSuspendMatch = /^\/api\/super-admin\/schools\/([^/]+)\/suspend$/.exec(url.pathname);
        if (superBillingMatch && request.method === "GET") {
          return send(200, { billingEmail: null, stripeCustomerId: null, stripeSubscriptionId: null });
        }
        if (superProductMatch) {
          const key = schoolKeyForId(superProductMatch[1]);
          if (!key) return send(404, { error: "missing" });
          if (request.method === "POST") model.schools[key].products.add("CLASSPILOT");
          if (request.method === "DELETE") model.schools[key].products.delete("CLASSPILOT");
          return send(200, { ok: true });
        }
        if (superSuspendMatch && request.method === "POST") {
          const key = schoolKeyForId(superSuspendMatch[1]);
          if (!key) return send(404, { error: "missing" });
          model.schools[key].status = "suspended";
          return send(200, { ok: true });
        }
        if (superSchoolMatch) {
          const key = schoolKeyForId(superSchoolMatch[1]);
          if (!key || model.schools[key].deleted) return send(404, { error: "missing" });
          const school = model.schools[key];
          if (request.method === "PATCH") {
            const body = await readBody(request);
            school.trackingEnabled = body.schoolHours?.enabled !== false;
            return send(200, { school: { ...school, products: [...school.products] } });
          }
          if (request.method === "DELETE") {
            school.deleted = true;
            model.deletedSchools.add(key);
            return send(200, { ok: true });
          }
          const admins = model.staff[key].filter((entry: any) => entry.role === "school_admin").map((entry: any) => ({
            id: entry.membershipId, userId: entry.userId, role: "admin", email: entry.user.email, displayName: entry.user.displayName,
          }));
          const teachers = model.staff[key].filter((entry: any) => entry.role === "teacher").map((entry: any) => ({
            id: entry.membershipId, userId: entry.userId, role: "teacher", email: entry.user.email, displayName: entry.user.displayName,
          }));
          return send(200, {
            ...school,
            products: [...school.products],
            admins,
            teachers,
            staff: [...admins, ...teachers],
            studentCount: model.students[key].length,
            schoolHours: { enabled: school.trackingEnabled, timezone: "America/New_York" },
          });
        }

        const schoolId = String(request.headers["x-school-id"] || "");
        const schoolKey = schoolKeyForId(schoolId);
        if (!schoolKey) return send(400, { error: `missing or invalid x-school-id for ${url.pathname}` });
        const school = model.schools[schoolKey];
        if (url.pathname === "/api/admin/users" && request.method === "GET") return send(200, { users: model.staff[schoolKey] });
        if (url.pathname === "/api/admin/users" && request.method === "POST") {
          const body = await readBody(request);
          const entry = {
            membershipId: `teacher-membership-${++model.teacherCounter}`,
            userId: `teacher-user-${model.teacherCounter}`,
            role: "teacher",
            user: { id: `teacher-user-${model.teacherCounter}`, email: body.email, displayName: body.name },
          };
          model.staff[schoolKey].push(entry);
          model.events.push(`teacher-created:${body.email}`);
          if (model.dropFirstTeacherResponse) {
            model.dropFirstTeacherResponse = false;
            request.socket.destroy();
            return;
          }
          return send(201, { user: entry.user, membership: { id: entry.membershipId, role: "teacher" } });
        }
        const adminUserMatch = /^\/api\/admin\/users\/([^/]+)(?:\/(password))?$/.exec(url.pathname);
        if (adminUserMatch) {
          const index = model.staff[schoolKey].findIndex((entry: any) => entry.membershipId === adminUserMatch[1]);
          if (request.method === "DELETE") {
            if (index >= 0) model.staff[schoolKey].splice(index, 1);
            return send(index >= 0 ? 200 : 404, { ok: index >= 0 });
          }
          if (request.method === "PATCH") {
            const body = await readBody(request);
            if (index < 0) return send(404, { error: "missing" });
            model.staff[schoolKey][index].role = body.role || model.staff[schoolKey][index].role;
            if (body.name) model.staff[schoolKey][index].user.displayName = body.name;
            return send(200, { membership: model.staff[schoolKey][index] });
          }
          if (request.method === "POST" && adminUserMatch[2] === "password") return send(index >= 0 ? 200 : 404, { ok: index >= 0 });
        }
        if (url.pathname === "/api/students" && request.method === "GET") return send(200, { students: model.students[schoolKey] });
        if (url.pathname === "/api/students/bulk" && request.method === "POST") {
          const body = await readBody(request);
          model.studentImportBatchSizes.push((body.students || []).length);
          if ((body.students || []).length > 10) return send(504, { error: "synthetic origin timeout" });
          for (const value of body.students || []) {
            if (model.students[schoolKey].some((student: any) => student.email === value.email)) continue;
            model.students[schoolKey].push({ ...value, id: `student-${schoolKey}-${model.students[schoolKey].length + 1}` });
            model.events.push(`student-imported:${schoolKey}`);
          }
          return send(200, { imported: body.students?.length || 0 });
        }
        const studentDeleteMatch = /^\/api\/students\/([^/]+)$/.exec(url.pathname);
        if (studentDeleteMatch && request.method === "DELETE") {
          const index = model.students[schoolKey].findIndex((entry: any) => entry.id === studentDeleteMatch[1]);
          if (index >= 0) model.students[schoolKey].splice(index, 1);
          return send(index >= 0 ? 200 : 404, { ok: index >= 0 });
        }
        if (url.pathname === "/api/classpilot/admin/classes" && request.method === "GET") {
          const all = [...model.classes.values()].filter((entry: any) => entry.schoolId === schoolId);
          return send(200, { classes: url.searchParams.get("status") === "all" ? all : all.filter((entry: any) => entry.status === "active") });
        }
        if (url.pathname === "/api/classpilot/admin/classes" && request.method === "POST") {
          const body = await readBody(request);
          const value = { id: `class-${++model.classCounter}`, schoolId, teacherId: body.primaryTeacherId, status: "active", scheduleEnabled: false, ...body };
          model.classes.set(value.id, value);
          model.rosters.set(value.id, new Set());
          model.events.push(`class-created:${value.id}`);
          return send(201, { class: value });
        }
        const classRosterMatch = /^\/api\/classpilot\/admin\/classes\/([^/]+)\/students(?:\/([^/]+))?$/.exec(url.pathname);
        if (classRosterMatch) {
          const roster = model.rosters.get(classRosterMatch[1]);
          if (!roster) return send(404, { error: "missing" });
          if (request.method === "GET") {
            const byId = new Map(model.students[schoolKey].map((entry: any) => [entry.id, entry]));
            return send(200, { students: [...roster].map((id) => byId.get(id)).filter(Boolean) });
          }
          if (request.method === "POST") {
            const body = await readBody(request);
            for (const id of body.studentIds || []) roster.add(id);
            return send(200, { ok: true });
          }
          if (request.method === "DELETE") {
            roster.delete(classRosterMatch[2]);
            return send(200, { ok: true });
          }
        }
        const classArchiveMatch = /^\/api\/classpilot\/admin\/classes\/([^/]+)\/archive$/.exec(url.pathname);
        if (classArchiveMatch && request.method === "POST") {
          const value = model.classes.get(classArchiveMatch[1]);
          if (!value) return send(404, { error: "missing" });
          value.status = "archived";
          return send(200, { class: value });
        }
        const classMatch = /^\/api\/classpilot\/admin\/classes\/([^/]+)$/.exec(url.pathname);
        if (classMatch && request.method === "PATCH") {
          const body = await readBody(request);
          const value = model.classes.get(classMatch[1]);
          if (!value) return send(404, { error: "missing" });
          Object.assign(value, body, { teacherId: body.primaryTeacherId || value.teacherId });
          return send(200, { class: value });
        }
        if (url.pathname === "/api/classpilot/enrollment-key" && request.method === "GET") {
          return send(200, { key: model.enrollment[schoolKey].key, autoEnrollStudents: model.enrollment[schoolKey].autoEnrollStudents });
        }
        if (url.pathname === "/api/classpilot/auto-enroll" && request.method === "PATCH") {
          const body = await readBody(request);
          model.enrollment[schoolKey].autoEnrollStudents = body.enabled === true;
          return send(200, { ok: true });
        }
        if (url.pathname === "/api/classpilot/enrollment-key/rotate" && request.method === "POST") {
          model.enrollment[schoolKey].generation += 1;
          model.enrollment[schoolKey].key = `enrollment-${schoolKey}-${model.enrollment[schoolKey].generation}`;
          return send(200, { key: model.enrollment[schoolKey].key });
        }
        if (url.pathname === "/api/classpilot/extension/register" && request.method === "POST") {
          const body = await readBody(request);
          if (model.students.primary.length + model.students.canary.length !== 1010) return send(409, { error: "registration before complete import" });
          const student = model.students[schoolKey].find((entry: any) => entry.email === body.studentEmail);
          if (!student) return send(404, { error: "student missing" });
          const token = issueToken(`device:${body.deviceId}`, {
            deviceId: body.deviceId, studentId: student.id, schoolId, sessionId: `device-session-${body.deviceId}`,
          });
          model.devices[schoolKey].set(body.deviceId, { deviceId: body.deviceId, studentId: student.id, schoolId, classId: body.classId, token });
          model.events.push(`device-registered:${body.deviceId}`);
          return send(200, { studentToken: token });
        }
        if (url.pathname === "/api/classpilot/extension/settings" && request.method === "GET") {
          return send(200, { enableTrackingHours: school.trackingEnabled });
        }
        if (url.pathname === "/api/classpilot/extension/sign-out" && request.method === "POST") {
          if (model.dropFirstSignOutResponse) {
            model.dropFirstSignOutResponse = false;
            request.socket.destroy();
            return;
          }
          return send(200, { success: true });
        }
        if (url.pathname === "/api/classpilot/devices" && request.method === "GET") return send(200, { devices: [...model.devices[schoolKey].values()] });
        if (url.pathname === "/api/classpilot/heartbeats" && request.method === "GET") return send(200, { heartbeats: [] });
        if (url.pathname === "/api/admin/cleanup-students" && request.method === "POST") {
          model.devices[schoolKey].clear();
          return send(200, { ok: true });
        }
        if (url.pathname === "/api/classpilot/teaching-sessions/start" && request.method === "POST") {
          const body = await readBody(request);
          const teacherIdentity = identityForEmail(bearerEmail);
          const session = {
            id: `session-${++model.sessionCounter}`,
            groupId: body.groupId,
            teacherId: teacherIdentity?.entry.userId,
            sessionMode: "live",
            endTime: null,
            schoolId,
          };
          model.sessions.set(session.id, session);
          return send(200, { session });
        }
        const sessionEndMatch = /^\/api\/classpilot\/teaching-sessions\/([^/]+)\/end$/.exec(url.pathname);
        if (sessionEndMatch && request.method === "POST") {
          const session = model.sessions.get(sessionEndMatch[1]);
          if (!session) return send(404, { error: "missing" });
          session.endTime = new Date().toISOString();
          return send(200, { session });
        }
        const sessionMatch = /^\/api\/classpilot\/teaching-sessions\/([^/]+)$/.exec(url.pathname);
        if (sessionMatch && request.method === "GET") {
          const session = model.sessions.get(sessionMatch[1]);
          return session ? send(200, { session }) : send(404, { error: "missing" });
        }
        return send(404, { error: `mock route missing: ${request.method} ${url.pathname}` });
      } catch (error) {
        return send(500, { error: error instanceof Error ? error.message : "mock failure" });
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    configValue.baseUrl = `http://127.0.0.1:${address.port}`;
    const localConfigPath = join(tempRoot, "full-lifecycle-config.json");
    const output = join(loadGatesRoot, "full-lifecycle-output");
    writeFileSync(localConfigPath, JSON.stringify(configValue));
    const saved = { ...process.env };
    const lifecycleBearer = "full-lifecycle-bearer-secret-sentinel";
    model.tokenEmails.set(lifecycleBearer, configValue.operatorMailboxEmail);
    Object.assign(process.env, cleanEnv({
      CLP_SUPER_ADMIN_BEARER: lifecycleBearer,
      CLP_FIXTURE_ADMIN_PASSWORD: "fixture-admin-password",
      CLP_FIXTURE_TEACHER_PASSWORD: "fixture-teacher-password",
      CLP_OPERATOR_ALIAS_CONFIRMED: "launch-safe-2026",
      CLP_CANARY_ALIAS_CONFIRMED: "launch-safe-2026",
    }));
    try {
      await assert.rejects(
        () => runPreparerCli(["provision", "--config", localConfigPath, "--output", output]),
        /Network request failed/,
      );
      const crashLedger = JSON.parse(readFileSync(join(output, FILES.ownership), "utf8"));
      assert.equal(Object.keys(crashLedger.schools).length, 2);
      assert.equal(Object.keys(crashLedger.pendingCreateIntents.teachers).length, 1);

      const provisioned: any = await runPreparerCli(["provision", "--config", localConfigPath, "--output", output]);
      assert.equal(provisioned.students, 1010);
      assert.equal(provisioned.teachers, 20);
      assert.equal(provisioned.classes, 20);
      assert.equal(provisioned.devicesRegistered, 1010);
      assert.equal(model.students.primary.length, 1000);
      assert.equal(model.students.canary.length, 10);
      assert.equal(model.studentImportBatchSizes.length, 101);
      assert.ok(model.studentImportBatchSizes.every((size: number) => size === 10));
      assert.equal(model.staff.primary.filter((entry: any) => entry.role === "teacher").length, 20);
      assert.equal(model.classes.size, 20);
      assert.equal([...model.sessions.values()].filter((entry: any) => !entry.endTime).length, 20);
      for (const filename of readdirSync(output)) {
        assert.doesNotMatch(readFileSync(join(output, filename), "utf8"), /full-lifecycle-bearer-secret-sentinel/);
      }
      const firstRegistration = model.events.findIndex((entry: string) => entry.startsWith("device-registered:"));
      assert.equal(model.events.filter((entry: string) => entry.startsWith("student-imported:")).length, 1010);
      const lastImport = model.events.map((entry: string, index: number) => entry.startsWith("student-imported:") ? index : -1).reduce((a: number, b: number) => Math.max(a, b), -1);
      assert.ok(lastImport >= 0 && firstRegistration > lastImport, "all 1,010 imports must finish before registration begins");

      const rerun: any = await runPreparerCli(["provision", "--config", localConfigPath, "--output", output]);
      assert.equal(rerun.devicesRegistered, 1010);
      assert.equal(model.students.primary.length + model.students.canary.length, 1010);
      assert.equal(model.staff.primary.filter((entry: any) => entry.role === "teacher").length, 20);
      assert.equal(model.classes.size, 20);
      assert.equal([...model.sessions.values()].filter((entry: any) => !entry.endTime).length, 20, "refresh rerun must end prior sessions before replacement");
      const ownership = JSON.parse(readFileSync(join(output, FILES.ownership), "utf8"));
      assert.equal(Object.keys(ownership.pendingCreateIntents.teachers).length, 0);

      const auth = JSON.parse(readFileSync(join(output, FILES.auth), "utf8"));
      const swappedCookieAuth = structuredClone(auth);
      [swappedCookieAuth.teacherAuth[0].teacherCookie, swappedCookieAuth.teacherAuth[1].teacherCookie] = [
        swappedCookieAuth.teacherAuth[1].teacherCookie,
        swappedCookieAuth.teacherAuth[0].teacherCookie,
      ];
      writePrivateJson(output, FILES.auth, swappedCookieAuth);
      await assert.rejects(
        () => runPreparerCli(["verify", "--config", localConfigPath, "--output", output]),
        /cookie returned a different fixture user identity/,
      );
      writePrivateJson(output, FILES.auth, auth);

      const verified: any = await runPreparerCli(["verify", "--config", localConfigPath, "--output", output]);
      assert.equal(verified.passed, true);
      assert.equal(verified.activeDeviceSessions, 1010);
      assert.equal(verified.activeSessions, 20);

      assert.equal(auth.schemaVersion, 2);
      assert.equal(auth.teacherAuth.length, 20);
      assert.equal(new Set(auth.teacherAuth.map((entry: any) => entry.teacherId)).size, 20);
      assert.ok(auth.teacherAuth.every((entry: any) => entry.schoolId === "school-primary" && entry.role === "teacher" && entry.studentIds.length === 40));
      const harnessScript = join(dirname(testFile), "../scripts/load/classpilot-load-test.mjs");
      const harnessEnv = { ...process.env } as NodeJS.ProcessEnv;
      for (const key of Object.keys(harnessEnv)) if (key.startsWith("LOAD_")) delete harnessEnv[key];
      Object.assign(harnessEnv, {
        NODE_ENV: "test",
        LOAD_TEST_ARTIFACT_ROOT: output,
        LOAD_BASE_URL: configValue.baseUrl,
        LOAD_DEVICE_MANIFEST: join(output, FILES.devices),
        LOAD_TEACHER_AUTH_FILE: join(output, FILES.auth),
        LOAD_TEACHER_SCHOOL_ID: "school-primary",
      });
      const harness = spawnSync(process.execPath, [harnessScript, "--validate-config"], { env: harnessEnv, encoding: "utf8", timeout: 20_000 });
      assert.equal(harness.status, 0, harness.stderr);
      assert.equal(JSON.parse(harness.stdout).launchContract.teacherActors, 20);

      model.dropFirstSignOutResponse = true;
      await assert.rejects(
        () => runPreparerCli(["deactivate", "--confirm", "launch-safe-2026", "--config", localConfigPath, "--output", output]),
        /Network request failed/,
      );
      const destructiveCheckpoint = JSON.parse(readFileSync(join(output, FILES.state), "utf8"));
      assert.ok(destructiveCheckpoint.deactivation.startedAt);
      assert.equal(destructiveCheckpoint.hold, undefined);
      const deactivated: any = await runPreparerCli(["deactivate", "--confirm", "launch-safe-2026", "--config", localConfigPath, "--output", output]);
      assert.equal(deactivated.completed, true);
      assert.equal(deactivated.hold.retainedFixtureAdmins, 2);
      assert.equal(deactivated.hold.syntheticTeacherMembershipsRemoved, true);
      assert.equal(deactivated.hold.tenantPostconditions.activeTeachingSessions, 0);
      assert.equal(model.students.primary.length + model.students.canary.length, 0);
      assert.equal(model.staff.primary.filter((entry: any) => entry.role === "teacher").length, 0);
      assert.equal(model.devices.primary.size + model.devices.canary.size, 0);
      assert.equal([...model.classes.values()].filter((entry: any) => entry.status === "active").length, 0);
      assert.equal([...model.sessions.values()].filter((entry: any) => !entry.endTime).length, 0);
      assert.equal(model.schools.primary.status, "suspended");
      assert.equal(model.schools.canary.status, "suspended");
      assert.equal(model.schools.primary.products.has("CLASSPILOT"), false);

      await assert.rejects(
        () => runPreparerCli(["cleanup", "--confirm", "launch-safe-2026", "--config", localConfigPath, "--output", output]),
        /Cleanup hold remains active/,
      );
      const heldState = JSON.parse(readFileSync(join(output, FILES.state), "utf8"));
      heldState.hold.cleanupNotBefore = new Date(Date.now() - 1_000).toISOString();
      writePrivateJson(output, FILES.state, heldState);
      const cleaned: any = await runPreparerCli(["cleanup", "--confirm", "launch-safe-2026", "--config", localConfigPath, "--output", output]);
      assert.equal(cleaned.completed, true);
      assert.deepEqual(new Set(cleaned.deletedOwnedSchoolKeys), new Set(["primary", "canary"]));
      assert.equal(cleaned.deletedSchoolPostconditions.primary.terminalState, "absent");
      assert.equal(cleaned.deletedSchoolPostconditions.canary.terminalState, "absent");
      assert.deepEqual(model.deletedSchools, new Set(["primary", "canary"]));
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("builds cleanup counts from a fully mocked live tenant-scoped API", async () => {
    let state: any;
    const readBody = async (request: import("node:http").IncomingMessage) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    };
    const server = createServer(async (request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        response.writeHead(status, { "content-type": "application/json", ...headers });
        response.end(JSON.stringify(body));
      };
      try {
        if (request.method === "POST" && url.pathname === "/api/auth/login") {
          const body = await readBody(request);
          const school = body.email === state?.schools?.primary?.adminEmail
            ? state.schools.primary
            : body.email === state?.schools?.canary?.adminEmail ? state.schools.canary : null;
          return send(200, {
            token: `token:${body.email}`,
            user: { id: `user:${body.email}`, email: body.email },
            memberships: school ? [{ id: `membership:${body.email}`, schoolId: school.id, schoolName: school.name, role: "admin" }] : [],
          }, { "set-cookie": `schoolpilot.sid=${encodeURIComponent(body.email)}; Path=/; HttpOnly` });
        }
        if (request.method === "GET" && url.pathname === "/api/auth/me") {
          const bearer = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
          if (bearer === `token:${config.operatorMailboxEmail}`) {
            return send(200, {
              token: bearer,
              user: { id: "super-user", email: config.operatorMailboxEmail, isSuperAdmin: true },
              memberships: [],
            });
          }
          const email = decodeURIComponent(/schoolpilot\.sid=([^;]+)/.exec(String(request.headers.cookie || ""))?.[1] || "");
          const school = email === state.schools.primary.adminEmail ? state.schools.primary : state.schools.canary;
          assert.equal(request.headers["x-school-id"], school.id);
          return send(200, {
            token: `verified:${email}`,
            user: { id: `user:${email}`, email },
            memberships: [{ id: `membership:${email}`, schoolId: school.id, schoolName: school.name, role: "admin" }],
          });
        }
        const auth = String(request.headers.authorization || "");
        const isCanary = auth.includes(state.schools.canary.adminEmail);
        for (const schoolKey of ["primary", "canary"]) {
          const school = state.schools[schoolKey];
          if (request.method === "GET" && url.pathname === `/api/super-admin/schools/${school.id}`) {
            return send(200, {
              ...school,
              status: "active",
              billingEmail: null,
              stripeCustomerId: null,
              stripeSubscriptionId: null,
              products: ["CLASSPILOT"],
              teachers: schoolKey === "primary" ? state.teachers : [],
              studentCount: state.students[schoolKey].length,
            });
          }
          if (request.method === "GET" && url.pathname === `/api/super-admin/schools/${school.id}/billing`) {
            return send(200, { billingEmail: null, stripeCustomerId: null, stripeSubscriptionId: null });
          }
        }
        if (request.method === "GET" && url.pathname === "/api/admin/users") {
          if (isCanary) {
            return send(200, { users: [{
              membershipId: "canary-admin-membership",
              userId: "canary-admin-user",
              role: "school_admin",
              user: { email: state.schools.canary.adminEmail, displayName: "Canary Fixture Admin" },
            }] });
          }
          return send(200, { users: [
            {
              membershipId: "primary-admin-membership",
              userId: "primary-admin-user",
              role: "school_admin",
              user: { email: state.schools.primary.adminEmail, displayName: "Load Fixture Admin" },
            },
            ...state.teachers.map((teacher: any) => ({
              membershipId: teacher.membershipId,
              userId: teacher.userId,
              role: "teacher",
              user: { email: teacher.email, displayName: teacher.name },
            })),
          ] });
        }
        if (request.method === "GET" && url.pathname === "/api/students") {
          return send(200, { students: isCanary ? state.students.canary : state.students.primary });
        }
        if (request.method === "GET" && url.pathname === "/api/classpilot/admin/classes") {
          return send(200, { classes: state.teachers.map((teacher: any) => ({
            id: teacher.classId,
            name: teacher.className,
            description: `synthetic-load-fixture:${state.fixtureId}:class:${String(teacher.ordinal).padStart(2, "0")}`,
            teacherId: teacher.userId,
            status: "active",
            scheduleEnabled: false,
          })) });
        }
        if (request.method === "GET" && url.pathname === "/api/classpilot/devices") {
          return send(200, { devices: state.devices
            .filter((device: any) => device.schoolKey === (isCanary ? "canary" : "primary"))
            .map((device: any) => ({ deviceId: device.deviceId, schoolId: device.schoolId })) });
        }
        const sessionMatch = /^\/api\/classpilot\/teaching-sessions\/([^/]+)$/.exec(url.pathname);
        if (request.method === "GET" && sessionMatch) {
          const session = state.sessions.find((entry: any) => entry.sessionId === decodeURIComponent(sessionMatch[1]));
          return session ? send(200, { session: { id: session.sessionId, groupId: session.classId, endTime: null } }) : send(404, { error: "missing" });
        }
        return send(404, { error: `mock route missing: ${request.method} ${url.pathname}` });
      } catch (error) {
        return send(500, { error: error instanceof Error ? error.message : "mock failure" });
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const configValue = { ...rawConfig(), baseUrl: `http://127.0.0.1:${address.port}` };
    const config = validateConfig(configValue);
    state = stateFromBlueprint(config);
    const output = preparePrivateOutputDirectory(join(loadGatesRoot, "live-cleanup-dry-run"), loadGatesRoot);
    const localConfigPath = join(tempRoot, "live-cleanup-config.json");
    writeFileSync(localConfigPath, JSON.stringify(configValue));
    writePrivateJson(output, FILES.state, state);
    const expiry = Math.floor(Date.now() / 1000) + 60 * 60;
    writePrivateJson(output, FILES.devices, state.devices.map((device: any) => ({
      deviceId: device.deviceId,
      studentId: device.studentId,
      schoolId: device.schoolId,
      classId: device.classId,
      studentToken: mockJwt({
        deviceId: device.deviceId,
        studentId: device.studentId,
        schoolId: device.schoolId,
        sessionId: `device-session:${device.deviceId}`,
        exp: expiry,
      }),
    })));
    writePrivateJson(output, FILES.commands, state.sessions.map((session: any) => ({
      teachingSessionId: session.sessionId,
      targetScope: "class",
      commandType: "open-tab",
      commandPayload: { url: config.commandUrl },
    })));
    const saved = { ...process.env };
    Object.assign(process.env, cleanEnv({
      CLP_SUPER_ADMIN_EMAIL: config.operatorMailboxEmail,
      CLP_SUPER_ADMIN_PASSWORD: "super-password",
      CLP_FIXTURE_ADMIN_PASSWORD: "fixture-admin-password",
    }));
    try {
      const result: any = await runPreparerCli([
        "deactivate", "--dry-run", "--config", localConfigPath, "--output", output,
      ]);
      assert.equal(result.mutationsPerformed, 0);
      assert.equal(result.live.source, "live-tenant-scoped-api");
      assert.deepEqual(result.live.students, { primary: 1000, canary: 10, total: 1010 });
      assert.deepEqual(result.live.devices, { primary: 1000, canary: 10, total: 1010 });
      assert.equal(result.live.teachers, 20);
      assert.equal(result.live.activeTeachingSessions, 20);
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
