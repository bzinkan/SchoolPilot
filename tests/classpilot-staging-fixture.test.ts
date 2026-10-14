import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { stagingOperatorConnection, stagingOperatorEnvironment } from "../src/cli/bootstrapClasspilotStagingOperator.js";
const { buildFixtureBlueprint, buildDryRunSummary, validateConfig, acknowledgeOwnedStagingPrimaryDomain } = await import(new URL("../scripts/load/prepare-classpilot-load-test.mjs", import.meta.url).href);
const { validateReliabilityCommandBodies, selectReliabilityCohort } = await import(new URL("../scripts/load/select-classpilot-reliability-cohort.mjs", import.meta.url).href);
const { freshStagingFixtureConfig } = await import(new URL("../scripts/load/create-classpilot-staging-fixture-config.mjs", import.meta.url).href);
const { loadSessionCookieName } = await import(new URL("../scripts/load/session-cookie.mjs", import.meta.url).href);
import { initialReliabilityCommandBurst, stampReliabilityFrame, readReliabilityFrame } from "../scripts/load/reliability-rendered-frame.mjs";

const host = "schoolpilot-staging-db.fixture.us-east-1.rds.amazonaws.com";
function bootstrapEnvironment(): NodeJS.ProcessEnv {
  return { APP_ENV: "staging", PUBLIC_BASE_URL: "https://staging.school-pilot.net", RLS_GUC_ENABLED: "true",
    CLP_STAGING_BOOTSTRAP_ACK: "FRESH_ISOLATED_STAGING_NO_CUSTOMER_DATA",
    DATABASE_URL: `postgresql://restricted:synthetic-password@${host}/schoolpilot_staging?sslmode=verify-full`,
    CLP_STAGING_DATABASE_HOST: host, CLP_STAGING_DATABASE_NAME: "schoolpilot_staging",
    CLP_SUPER_ADMIN_EMAIL: "operator@classpilot-staging.invalid", CLP_SUPER_ADMIN_PASSWORD: "synthetic-test-password-at-least-24" };
}

test("staging operator bootstrap binds origin, RDS instance, database, TLS and disabled providers before connection", () => {
  assert.ok(stagingOperatorEnvironment(bootstrapEnvironment()).databaseUrl);
  const invalid: NodeJS.ProcessEnv[] = [
    { APP_ENV: "production" }, { PUBLIC_BASE_URL: "https://school-pilot.net" },
    { RLS_GUC_ENABLED: "false" }, { CLP_STAGING_BOOTSTRAP_ACK: "" },
    { CLP_STAGING_DATABASE_HOST: "other.fixture.us-east-1.rds.amazonaws.com" },
    { DATABASE_URL: `postgresql://restricted:synthetic-password@${host}/schoolpilot_staging?sslmode=no-verify` },
    { DATABASE_URL: `postgresql://restricted:synthetic-password@${host}/schoolpilot_staging?sslmode=verify-full&host=other.example.org` },
    { DATABASE_URL: `postgresql://restricted:synthetic-password@${host}/schoolpilot_staging?sslmode=verify-full&sslmode=no-verify` },
    { DATABASE_URL: `postgresql://restricted:synthetic-password@${host}:6543/schoolpilot_staging?sslmode=verify-full` },
    { DATABASE_URL: `postgresql://restricted:synthetic-password@${host}/schoolpilot` },
    { CLP_SUPER_ADMIN_EMAIL: "real@example.org" }, { SENDGRID_API_KEY: "synthetic-key" },
    { TELEGRAM_BOT_TOKEN: "synthetic-key" }, { CLP_SUPER_ADMIN_PASSWORD: "short" },
  ];
  for (const mutation of invalid) assert.throws(() => stagingOperatorEnvironment({ ...bootstrapEnvironment(), ...mutation }));
  const productionHost = "schoolpilot-db.fixture.us-east-1.rds.amazonaws.com";
  assert.throws(() => stagingOperatorEnvironment({ ...bootstrapEnvironment(), CLP_STAGING_DATABASE_HOST: productionHost,
    DATABASE_URL: `postgresql://restricted:synthetic-password@${productionHost}/schoolpilot_staging?sslmode=verify-full` }));
});

test("actual pg Client retains explicit verified TLS configuration without connection-string overrides", () => {
  const configuration = stagingOperatorConnection(stagingOperatorEnvironment(bootstrapEnvironment()).databaseUrl);
  assert.equal(configuration.connectionString, undefined);
  const parameters = Reflect.get(new pg.Client(configuration), "connectionParameters");
  assert.equal(parameters.host, host);
  assert.equal(parameters.port, 5432);
  assert.equal(parameters.database, "schoolpilot_staging");
  assert.deepEqual(parameters.ssl, configuration.ssl);
  assert.equal(parameters.ssl.rejectUnauthorized, true);
});

function config(primary = 800) {
  const domain = "classpilot-staging.invalid";
  return { version: 1, fixtureId: `stage-reliability-${primary}`, baseUrl: "https://staging.school-pilot.net",
    syntheticStaging: true, reliabilityDeviceCount: primary,
    ownershipAcknowledgement: "TOOL_OWNED_MARKED_NON_BILLABLE_SYNTHETIC_TENANTS_ONLY",
    emailDeliveryAcknowledgement: "ISOLATED_STAGING_INVALID_ADDRESSES_NO_EMAIL_TRANSPORT",
    operatorMailboxEmail: `operator@${domain}`, operatorOwnedAdminEmail: `operator+primary-${primary}@${domain}`,
    schools: { primary: { name: `[SYNTHETIC LOAD TEST - NON-BILLABLE] stage-reliability-${primary} Primary`, domain, adminEmail: `operator+primary-${primary}@${domain}` },
      canary: { name: `[SYNTHETIC LOAD TEST - NON-BILLABLE] stage-reliability-${primary} Canary`, domain, adminEmail: `operator+canary-${primary}@${domain}` } },
    aliases: { teacherPrefix: `operator+t${primary}`, primaryStudentPrefix: `operator+s${primary}`, canaryStudentPrefix: `operator+c${primary}` },
    allowSchoolCreation: true, cleanupOwnedSchools: false };
}

test("staging no-mail profile cannot bypass mailbox confirmation for production, non-reserved domains or normal fixtures", () => {
  assert.equal(validateConfig(config()).syntheticStaging, true);
  assert.throws(() => validateConfig({ ...config(), baseUrl: "https://school-pilot.net" }));
  assert.throws(() => validateConfig({ ...config(), baseUrl: "https://staging.school-pilot.net/path" }));
  assert.throws(() => validateConfig({ ...config(), syntheticStaging: false }));
  assert.throws(() => validateConfig({ ...config(), reliabilityDeviceCount: 799 }));
  const ordinary = config();
  ordinary.schools.primary.domain = "example.org";
  ordinary.schools.primary.adminEmail = "operator+primary@example.org";
  assert.throws(() => validateConfig(ordinary));
  assert.throws(() => validateConfig({ ...config(), operatorMailboxEmail: "other@classpilot-staging.invalid" }));
});

test("staging shared-domain creation acknowledges only its exact checkpoint-owned primary school", () => {
  const normalized = validateConfig(freshStagingFixtureConfig(40, "abcdef1234"));
  const primary = { id: "owned-primary", name: normalized.schools.primary.name, domain: normalized.schools.primary.domain,
    status: "active", deletedAt: null, billingEmail: null, stripeCustomerId: null, stripeSubscriptionId: null };
  const ownership = { fixtureId: normalized.fixtureId, baseUrl: normalized.baseUrl, schools: { primary: {
    id: primary.id, name: primary.name, domain: primary.domain, createdByTool: true, billingProtectionVerified: true,
  } } };
  assert.equal(acknowledgeOwnedStagingPrimaryDomain(normalized, "primary", [], ownership), false);
  assert.equal(acknowledgeOwnedStagingPrimaryDomain(normalized, "canary", [primary], ownership), true);
  assert.equal(acknowledgeOwnedStagingPrimaryDomain({ ...normalized, syntheticStaging: false }, "canary", [primary], ownership), false);
  assert.throws(() => acknowledgeOwnedStagingPrimaryDomain({ ...normalized, baseUrl: "https://school-pilot.net" }, "canary", [primary], ownership));
  assert.throws(() => acknowledgeOwnedStagingPrimaryDomain(normalized, "primary", [primary], ownership));
  assert.throws(() => acknowledgeOwnedStagingPrimaryDomain(normalized, "canary", [primary, { ...primary, id: "unowned-sibling" }], ownership));
  assert.throws(() => acknowledgeOwnedStagingPrimaryDomain(normalized, "canary", [primary, { ...primary, id: "unowned-suspended", status: "suspended" }], ownership));
  assert.throws(() => acknowledgeOwnedStagingPrimaryDomain(normalized, "canary", [{ ...primary, id: "unowned-replacement" }], ownership));
  assert.throws(() => acknowledgeOwnedStagingPrimaryDomain(normalized, "canary", [{ ...primary, billingEmail: "billing@example.org" }], ownership));
  assert.throws(() => acknowledgeOwnedStagingPrimaryDomain(normalized, "canary", [primary], { ...ownership, fixtureId: "another-fixture" }));
  assert.throws(() => acknowledgeOwnedStagingPrimaryDomain(normalized, "canary", [primary], { ...ownership, schools: {} }));
  assert.notEqual(normalized.schools.primary.domain, freshStagingFixtureConfig(500, "abcdef1234").schools.primary.domain);
});

test("fresh 500 roster is exactly twenty disjoint groups of25; 40/800 retain full40-student rosters and ten foreign canaries", () => {
  for (const count of [40, 500, 800]) {
    const normalized = validateConfig(config(count));
    const blueprint = buildFixtureBlueprint(normalized);
    const size = count === 500 ? 25 : 40;
    assert.equal(blueprint.teachers.length, 20);
    assert.equal(blueprint.canaryStudents.length, 10);
    assert.equal(blueprint.classes.length, 20);
    assert.ok(blueprint.classes.every((group: { studentEmails: string[] }) => group.studentEmails.length === size));
    assert.equal(new Set(blueprint.classes.flatMap((group: { studentEmails: string[] }) => group.studentEmails)).size, size * 20);
    assert.equal(blueprint.devices.filter((device: { classOrdinal: number | null }) => device.classOrdinal !== null).length, size * 20);
    const dry = buildDryRunSummary(normalized);
    assert.equal(dry.expected.classes.studentsEach, size);
    assert.ok(dry.requiredEnvironment.includes(`CLP_STAGING_NO_EMAIL_CONFIRMED=${normalized.fixtureId}`));
    assert.ok(!dry.requiredEnvironment.some((value: string) => value.includes("ALIAS_CONFIRMED")));
  }
});

test("cohort export refuses tampered URLs, broad selectors, unknown/duplicate class commands", () => {
  const actors = [{ teachingSessionId: "exact-session" }];
  const body = { teachingSessionId: "exact-session", targetScope: "class", commandType: "open-tab", commandPayload: { url: "https://example.edu/fixture" } };
  validateReliabilityCommandBodies([body], actors, body.commandPayload.url);
  assert.throws(() => validateReliabilityCommandBodies([{ ...body, commandPayload: { url: "https://other.example.org" } }], actors, body.commandPayload.url));
  assert.throws(() => validateReliabilityCommandBodies([{ ...body, deviceId: "private-device" }], actors, body.commandPayload.url));
  assert.throws(() => validateReliabilityCommandBodies([{ ...body, commandPayload: { ...body.commandPayload, studentIds: [] } }], actors, body.commandPayload.url));
  assert.throws(() => validateReliabilityCommandBodies([{ ...body, teachingSessionId: "unknown" }], actors, body.commandPayload.url));
  assert.throws(() => validateReliabilityCommandBodies([body, body], actors, body.commandPayload.url));
});

test("initial reliability commands all enter before any response, and unique frame stamps preserve exact JPEG size", async () => {
  const entered: number[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const burst = initialReliabilityCommandBurst(Array.from({ length: 20 }, (_, index) => index), async (_body: number, index: number) => {
    entered.push(index); await held;
  });
  assert.equal(entered.length, 20);
  release(); await burst;
  const jpeg = Buffer.alloc(40960, 0x4c); jpeg[0] = 255; jpeg[1] = 216; jpeg[jpeg.length - 2] = 255; jpeg[jpeg.length - 1] = 217;
  const source = 'data:image/jpeg;base64,' + jpeg.toString('base64');
  const timestamp = Date.now(), first = stampReliabilityFrame(source, timestamp, 1), second = stampReliabilityFrame(source, timestamp, 2);
  assert.notEqual(first, second);
  assert.equal(Buffer.from(first.split(',')[1]!, 'base64').length, 40960);
  assert.deepEqual(readReliabilityFrame(first), { capturedAt: timestamp, ordinal: 1 });
  assert.equal(readReliabilityFrame(source), null);
  assert.throws(() => stampReliabilityFrame('data:image/png;base64,aaa', timestamp, 1));
});

test("fresh generated staging fixtures export exact50/510/810 governed actors and refuse cross-bound source devices", () => {
  for (const count of [40, 500, 800]) {
    const normalized = validateConfig(freshStagingFixtureConfig(count, 'abcdef1234'));
    const blueprint = buildFixtureBlueprint(normalized);
    const students = {
      primary: blueprint.primaryStudents.map((student: { ordinal: number }) => ({ ...student, id: `primary-student-${student.ordinal}` })),
      canary: blueprint.canaryStudents.map((student: { ordinal: number }) => ({ ...student, id: `canary-student-${student.ordinal}` })),
    };
    const teachers = blueprint.teachers.map((teacher: { ordinal: number }) => ({ ...teacher, userId: `teacher-${teacher.ordinal}`,
      membershipId: `membership-${teacher.ordinal}`, classId: `class-${teacher.ordinal}`, className: blueprint.classes[teacher.ordinal - 1].name }));
    const devices = blueprint.devices.map((device: { schoolKey: "primary" | "canary"; studentOrdinal: number; classOrdinal: number | null }) => ({
      ...device, schoolId: device.schoolKey, studentId: students[device.schoolKey][device.studentOrdinal - 1].id,
      classId: device.classOrdinal === null ? null : `class-${device.classOrdinal}`,
    }));
    const schools = Object.fromEntries(["primary", "canary"].map(key => [key, { ...normalized.schools[key], id: key,
      createdByTool: true, nonBillableVerifiedAt: new Date().toISOString(), billingProtectionVerified: true }]));
    const sessions = teachers.map((teacher: { userId: string; classId: string }, index: number) => ({ teacherUserId: teacher.userId,
      classId: teacher.classId, sessionId: `session-${index}` }));
    const state = { schemaVersion: 1, fixtureId: normalized.fixtureId, baseUrl: normalized.baseUrl,
      ownershipAcknowledgement: normalized.ownershipAcknowledgement, schools, students, teachers, devices, sessions,
      admin: { userId: "admin", email: normalized.schools.primary.adminEmail } };
    const expiresAt = new Date(Date.now() + 48 * 3600_000).toISOString();
    const jwt = (userId: string, email: string) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ userId, email, exp: Math.floor(Date.parse(expiresAt) / 1000) })).toString('base64url')}.synthetic`;
    const teacherAuth = teachers.map((teacher: { userId: string; email: string; classId: string }, index: number) => ({ teacherId: teacher.userId,
      schoolId: "primary", role: "teacher", teachingSessionId: sessions[index].sessionId,
      teacherCookie: `${loadSessionCookieName()}=synthetic-${index}`, csrfToken: `csrf-${index}`, teacherToken: jwt(teacher.userId, teacher.email), expiresAt,
      studentIds: devices.filter((device: { classId: string | null }) => device.classId === teacher.classId).map((device: { studentId: string }) => device.studentId) }));
    const auth = { schemaVersion: 2, baseUrl: normalized.baseUrl, schoolId: "primary", role: "school_admin",
      expiresAt, deviceManifestExpiresAt: expiresAt, teacherCookie: `${loadSessionCookieName()}=synthetic-admin`, csrfToken: "admin-csrf",
      teacherToken: jwt("admin", state.admin.email), teacherAuth };
    const manifest = devices.map((device: { deviceId: string; studentId: string; schoolId: string; classId: string | null }) => ({
      deviceId: device.deviceId, studentId: device.studentId, schoolId: device.schoolId, classId: device.classId, studentToken: "synthetic-device-token" }));
    const commands = teacherAuth.map((actor: { teachingSessionId: string }) => ({ teachingSessionId: actor.teachingSessionId,
      targetScope: "class", commandType: "open-tab", commandPayload: { url: normalized.commandUrl } }));
    const input = { config: normalized, state, auth, devices: manifest, commands, primaryDevices: count };
    const selected = selectReliabilityCohort(input);
    assert.equal(selected.devices.length, count + 10);
    assert.equal(selected.auth.teacherAuth.length, count === 40 ? 1 : 20);
    assert.ok(selected.devices.slice(0, 10).every((device: { schoolId: string }) => device.schoolId === "canary"));
    const tampered = structuredClone(manifest); tampered[10]!.studentId = "foreign-student";
    assert.throws(() => selectReliabilityCohort({ ...input, devices: tampered }));
  }
});
