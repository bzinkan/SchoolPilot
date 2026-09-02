import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  SCHOOLS_STAFF_PASSWORD_LOGIN_EXPAND_SQL,
  STAFF_IDENTITY_CONTRACT_MIGRATION_IDS,
  schoolPilot27ExpandMigrations,
  schoolPilot27Migrations,
} from "../src/db/migrations27.js";
import { loginSchema, staffPasswordLoginSchema } from "../src/schema/validation.js";

const STAFF_PASSWORD_LOGIN_MIGRATION_ID = "20260902_schools_staff_password_login_expand";

function source(relativePath: string): string {
  // Repository files are CRLF; normalise so multi-line markers stay simple.
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

function slice(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  assert.ok(start >= 0, `missing marker: ${startMarker}`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `missing boundary after: ${startMarker}`);
  return text.slice(start, end);
}

test("schools schema declares the staff password policy column with a true default", () => {
  const schema = source("src/schema/core.ts");
  assert.match(
    schema,
    /staffPasswordLoginEnabled: boolean\("staff_password_login_enabled"\)\.notNull\(\)\.default\(true\)/
  );
});

test("staff password policy migration is ledgered before the deferred staff identity contract", () => {
  const policyIndex = schoolPilot27Migrations.findIndex(
    (migration) => migration.id === STAFF_PASSWORD_LOGIN_MIGRATION_ID
  );
  const contractIndex = schoolPilot27Migrations.findIndex(
    (migration) => migration.id === STAFF_IDENTITY_CONTRACT_MIGRATION_IDS[0]
  );
  assert.ok(policyIndex >= 0, "policy migration must be in the ordered manifest");
  assert.ok(contractIndex > policyIndex, "policy migration must precede the deferred contract");
  assert.ok(
    schoolPilot27ExpandMigrations.some((migration) => migration.id === STAFF_PASSWORD_LOGIN_MIGRATION_ID),
    "policy migration must ship in the production expand plan"
  );

  const migration = schoolPilot27Migrations[policyIndex];
  assert.equal(migration?.mode, "transactional");
  assert.equal(
    migration?.checksum,
    createHash("sha256").update(SCHOOLS_STAFF_PASSWORD_LOGIN_EXPAND_SQL).digest("hex")
  );
  assert.match(SCHOOLS_STAFF_PASSWORD_LOGIN_EXPAND_SQL, /SET LOCAL lock_timeout = '15s'/);
  assert.match(SCHOOLS_STAFF_PASSWORD_LOGIN_EXPAND_SQL, /SET LOCAL statement_timeout = '5min'/);
  assert.match(
    SCHOOLS_STAFF_PASSWORD_LOGIN_EXPAND_SQL,
    /ALTER TABLE schools\s+ADD COLUMN IF NOT EXISTS staff_password_login_enabled BOOLEAN NOT NULL DEFAULT true;/
  );
  assert.doesNotMatch(SCHOOLS_STAFF_PASSWORD_LOGIN_EXPAND_SQL, /DROP|UPDATE schools/);
});

test("non-production startup bootstrap mirrors the additive column", () => {
  const index = source("src/index.ts");
  const startup = slice(
    index,
    "export async function runStartupMigrations",
    "async function runMigrationsAndExit"
  );
  assert.match(
    startup,
    /ADD COLUMN IF NOT EXISTS kiosk_classpilot_group_id VARCHAR,[\s\S]{0,400}ADD COLUMN IF NOT EXISTS staff_password_login_enabled BOOLEAN NOT NULL DEFAULT true/
  );
});

test("login schema accepts the optional client hint and rejects unknown clients", () => {
  const credentials = { email: "staff@example.edu", password: "secret" };
  assert.equal(loginSchema.safeParse(credentials).success, true);
  assert.equal(loginSchema.safeParse({ ...credentials, client: "web" }).success, true);
  assert.equal(loginSchema.safeParse({ ...credentials, client: "gopilot-native" }).success, true);
  assert.equal(loginSchema.safeParse({ ...credentials, client: "android" }).success, false);

  assert.equal(staffPasswordLoginSchema.safeParse({ enabled: false }).success, true);
  assert.equal(staffPasswordLoginSchema.safeParse({ enabled: "false" }).success, false);
  assert.equal(staffPasswordLoginSchema.safeParse({}).success, false);
  assert.equal(
    staffPasswordLoginSchema.safeParse({ enabled: true, name: "Renamed" }).success,
    false,
    "policy route must not accept generic school fields"
  );
});

test("password login gate runs after credential verification and before the web session", () => {
  const auth = source("src/routes/auth.ts");
  const login = slice(auth, 'router.post("/login"', "// POST /api/auth/register");

  const compareIndex = login.indexOf("comparePassword(");
  const clearIndex = login.indexOf("clearAttempts(");
  const noSchoolIndex = login.indexOf("NO_ACTIVE_SCHOOL_ERROR");
  const gateIndex = login.indexOf("STAFF_PASSWORD_LOGIN_DISABLED");
  const nativeIndex = login.indexOf('parsed.data.client === "gopilot-native"');
  const sessionIndex = login.indexOf("establishWebSession(");

  assert.ok(compareIndex >= 0 && clearIndex > compareIndex);
  assert.ok(noSchoolIndex > clearIndex);
  assert.ok(gateIndex > noSchoolIndex, "gate must follow the no-active-school check");
  assert.ok(nativeIndex > noSchoolIndex && nativeIndex < sessionIndex);
  assert.ok(sessionIndex > gateIndex, "gate must precede establishWebSession");
  assert.match(login, /user\.isSuperAdmin\s*\|\|\s*schoolIdentities\.some\(/);
  assert.match(login, /staffPasswordLoginEnabled !== false/);
  assert.match(login, /reason: "password_login_disabled"/);
  assert.match(login, /action: "auth\.login\.password_policy_exempt"/);
  assert.match(login, /res\.status\(403\)\.json\(\{\s*error: STAFF_PASSWORD_LOGIN_DISABLED_ERROR,\s*code: "STAFF_PASSWORD_LOGIN_DISABLED",/);

  const serializer = slice(auth, "function serializeSchoolIdentity", "const router = Router()");
  assert.match(serializer, /staffPasswordLoginEnabled: identity\.school\.staffPasswordLoginEnabled !== false/);

  // The Google callback path is untouched by the policy.
  const google = slice(auth, "// GET /api/auth/google/callback", "// POST /api/auth/logout");
  assert.doesNotMatch(google, /STAFF_PASSWORD_LOGIN/);
});

test("school routes keep the policy on its own audited route", () => {
  const schools = source("src/routes/schools.ts");
  const genericPut = slice(schools, 'router.put(\n  "/:schoolId",', "// PATCH /api/schools/:schoolId");
  const genericPatch = slice(schools, 'router.patch(\n  "/:schoolId",', "// PUT /api/schools/:schoolId/staff-password-login");
  for (const handler of [genericPut, genericPatch]) {
    assert.match(handler, /requireRole\("admin"\)/, "generic update stays admin-only");
    assert.doesNotMatch(handler, /requireRole\("admin", "school_admin"\)/);
    assert.match(handler, /rejectStaffPasswordLoginBypass\(req, res\)/);
  }
  assert.match(schools, /code: "STAFF_PASSWORD_LOGIN_MANAGED_IN_SETTINGS",\s*managementUrl: "\/classpilot\/settings"/);

  const policyRoute = slice(schools, '"/:schoolId/staff-password-login"', "// DELETE /api/schools/:schoolId");
  assert.match(policyRoute, /requireSchoolContext,\s*requireRole\("admin", "school_admin"\)/);
  assert.match(policyRoute, /staffPasswordLoginSchema\.safeParse\(req\.body\)/);
  assert.match(policyRoute, /updateSchool\(schoolId, \{\s*staffPasswordLoginEnabled: parsed\.data\.enabled,\s*\}\)/);
  assert.match(policyRoute, /action: "school\.staff_password_login\.updated"/);
  assert.match(policyRoute, /school: sanitizeSchool\(school\)/);
});

test("web client sends the client hint, honours the policy code, and manages it from Settings", () => {
  const authContext = source("schoolpilot-app/src/contexts/AuthContext.jsx");
  assert.match(authContext, /const login = async \(email, password, options = \{\}\)/);
  assert.match(authContext, /\.\.\.\(options\.client \? \{ client: options\.client \} : \{\}\)/);

  const login = source("schoolpilot-app/src/pages/Login.jsx");
  assert.match(login, /login\(email, password, \{ client: isGoPilotApp \? 'gopilot-native' : 'web' \}\)/);
  assert.match(login, /err\.response\?\.data\?\.code === 'STAFF_PASSWORD_LOGIN_DISABLED'/);
  assert.match(login, /if \(!isGoPilotApp\) setShowEmailLogin\(false\)/);

  const hook = source("schoolpilot-app/src/hooks/useClassPilotAuth.js");
  assert.match(hook, /staffPasswordLoginEnabled: activeMembership\.staffPasswordLoginEnabled !== false/);

  const settings = source("schoolpilot-app/src/products/classpilot/pages/Settings.jsx");
  assert.match(settings, /apiRequest\("PUT", `\/schools\/\$\{currentUser\?\.schoolId\}\/staff-password-login`, \{ enabled \}\)/);
  assert.match(settings, /Allow email and password sign-in for staff/);
  assert.match(settings, /When off, staff sign in to the web app with Google only\. The GoPilot staff app is not affected\./);
  assert.match(settings, /school\?\.staffPasswordLoginEnabled !== false/);
  assert.doesNotMatch(settings, /queryKey: \[[^\]]*staff-password-login/, "policy is read from the auth context, not a new query");
});
