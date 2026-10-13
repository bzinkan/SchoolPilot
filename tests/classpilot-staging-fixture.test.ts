import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { stagingOperatorConnection, stagingOperatorEnvironment } from "../src/cli/bootstrapClasspilotStagingOperator.js";
const { buildFixtureBlueprint, buildDryRunSummary, validateConfig } = await import(new URL("../scripts/load/prepare-classpilot-load-test.mjs", import.meta.url).href);
const { validateReliabilityCommandBodies } = await import(new URL("../scripts/load/select-classpilot-reliability-cohort.mjs", import.meta.url).href);
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
