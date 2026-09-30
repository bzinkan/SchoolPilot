import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PASSPILOT_RULES_ACTIVE_DESTINATION_INDEX_SQL,
  PASSPILOT_RULES_INDEXES_CONTRACT,
  PASSPILOT_RULES_SQL,
  PASSPILOT_RULES_STUDENT_ISSUED_INDEX_SQL,
  passpilotRulesIndexesMigration,
  passpilotRulesMigration,
} from "../src/db/passpilotRulesMigration.js";
import {
  STAFF_IDENTITY_CONTRACT_MIGRATION_IDS,
  schoolPilot27ExpandMigrations,
  schoolPilot27Migrations,
} from "../src/db/migrations27.js";
import { microsoftSignInMigration } from "../src/db/microsoftSignInMigration.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = (path: string) => readFileSync(join(root, path), "utf8");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `missing marker: ${start}`);
  const to = text.indexOf(end, from + start.length);
  assert.ok(to > from, `missing marker after ${start}: ${end}`);
  return text.slice(from, to);
}

function inOrder(text: string, markers: string[], label: string) {
  let previous = -1;
  for (const marker of markers) {
    const index = text.indexOf(marker, previous + 1);
    assert.ok(index > previous, `${label}: expected ${marker} after the previous marker`);
    previous = index;
  }
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const RULE_TABLES = [
  "passpilot_destination_policies",
  "passpilot_pass_limits",
  "passpilot_encounter_restrictions",
  "passpilot_pass_denials",
];
const TENANT_PREDICATE =
  "school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on'";

describe("PassPilot rule enforcement placement", () => {
  it("evaluates rules after the per-school lock and before each transactional insert", () => {
    const storage = source("src/services/storage.ts");
    for (const [name, next] of [
      ["createLegacyPass", "export async function returnPass"],
      ["createCanonicalPass", "export async function updateCanonicalKioskClass"],
    ] as const) {
      const body = between(storage, `export async function ${name}(`, next);
      inOrder(body, [
        "const ruleEvaluatedAt = new Date();",
        "(transaction ?? db).transaction(",
        "takePasspilotClassLock(",
        "enforcePasspilotIssuanceRules(tx, {",
        "now: ruleEvaluatedAt,",
        ".insert(passes)",
        "ruleOverrideCode: overriddenCode,",
      ], name);
      assert.match(body, /issuedVia: authorization\??\.kiosk \? "kiosk" : authorization\??\.issuanceChannel \?\? "teacher"/);
      assert.match(body, /override: authorization\??\.kiosk \? null : authorization\??\.ruleOverride \?\? null/);
    }
    const kiosk = between(
      source("src/services/passpilotKioskAssignments.ts"),
      "export async function createActivityKioskPass(",
      "export async function returnTeacherKioskPass",
    );
    inOrder(kiosk, [
      "const ruleEvaluatedAt = new Date();",
      "db.transaction(",
      "lockKioskSchool(",
      "enforcePasspilotIssuanceRules(tx, {",
      ".insert(passes)",
    ], "createActivityKioskPass");
    assert.match(kiosk, /issuedVia: "kiosk", actorUserId: null/);
    assert.match(kiosk, /override: null/);
  });

  it("keeps the test-only createPass seeder rule-free", () => {
    const seeder = between(source("src/services/storage.ts"), "export async function createPass(", "export async function createLegacyPass(");
    assert.doesNotMatch(seeder, /enforcePasspilotIssuanceRules/);
    assert.match(seeder, /db\.insert\(passes\)\.values\(data\)/);
  });

  it("returns before any query while the mode is off", () => {
    const helper = between(source("src/services/passpilotRules.ts"), "export async function enforcePasspilotIssuanceRules(", "// DESTINATION_CAPACITY");
    const firstAwait = helper.indexOf("await ");
    const modeGate = helper.indexOf('if (readPasspilotRulesMode() !== "on") return { overriddenCode: null };');
    assert.ok(modeGate > 0 && modeGate < firstAwait, "the mode gate must precede the first query");
  });

  it("maps rule denials at every issuance caller without rethrowing them", () => {
    const callers = sourceFiles(join(root, "src"))
      .filter((path) => !/services[\\/](storage|passpilotKioskAssignments)\.ts$/.test(path))
      .filter((path) => /\b(createLegacyPass|createCanonicalPass|createActivityKioskPass)\(/.test(readFileSync(path, "utf8")))
      .map((path) => relative(root, path).replaceAll("\\", "/"))
      .sort();
    assert.deepEqual(callers, ["src/routes/passpilot/kiosk.ts", "src/routes/passpilot/passes.ts", "src/services/chatToolExecutor.ts", "src/services/passpilotAppointments.ts"]);
    const appointments = source("src/routes/passpilot/appointments.ts");
    assert.match(appointments, /isPasspilotRuleError\(error\)/);
    assert.match(appointments, /await recordPasspilotRuleDenial\(error.passpilotRule\)/);
    assert.match(appointments, /res.status\(409\).json\(passpilotRuleTeacherResponse\(error, await getRequestPassPilotRole\(req, res\)\)\)/);

    const teacher = between(source("src/routes/passpilot/passes.ts"), 'router.post("/", async', 'router.patch("/:id/return"');
    inOrder(teacher, [
      'readPasspilotRulesMode() === "on" && body.overrideRuleCode !== undefined',
      "PASSPILOT_RULE_OVERRIDE_INVALID",
      "canOverridePasspilotRules(role)",
      "PASSPILOT_RULE_OVERRIDE_FORBIDDEN",
      'issuanceChannel: "teacher"',
      "isPasspilotRuleError(err)",
      "await recordPasspilotRuleDenial(err.passpilotRule);",
      "return res.status(409).json(passpilotRuleTeacherResponse(err, role));",
      "if (ruleOutcome.overridden)",
      "await recordPasspilotRuleDenial(ruleOutcome.overridden);",
      "await logAuditStrict({",
      'action: "passpilot.rule.override"',
    ], "teacher issue route");

    const kiosk = between(source("src/routes/passpilot/kiosk.ts"), 'router.post("/checkout"', 'router.post("/checkin"');
    assert.equal((kiosk.match(/if \(isPasspilotRuleError\((?:err|error)\)\) \{/g) || []).length, 2);
    assert.equal((kiosk.match(/return res\.status\(409\)\.json\(passpilotRuleKioskResponse\((?:err|error)\)\);/g) || []).length, 2,
      "kiosk rule denials answer 409 directly instead of reaching errorHandler");
    assert.equal((kiosk.match(/await recordPasspilotRuleDenial\((?:err|error)\.passpilotRule\);/g) || []).length, 2);

    const assistant = between(source("src/services/chatToolExecutor.ts"), "issue_pass: async", "// === CLASSPILOT ANALYTICS ===");
    assert.equal((assistant.match(/issuanceChannel: "ai"/g) || []).length, 2);
    inOrder(assistant, [
      "if (isPasspilotRuleError(err)) {",
      "await recordPasspilotRuleDenial(err.passpilotRule);",
      "return { success: false, error: passpilotRuleAssistantMessage(err) };",
      "throw err;",
    ], "issue_pass");
  });

  it("shapes pass override metadata for the verified viewer while kiosks use the safe default", () => {
    assert.match(source("src/services/passpilotClasses.ts"), /\.\.\.withoutNullRuleOverride\(pass, viewerRole\),/);
    assert.match(between(source("src/routes/passpilot/passes.ts"), "async function enrichPasses", "// Map legacy passType"),
      /\.\.\.withoutNullRuleOverride\(pass, viewerRole\),/);
    assert.match(source("src/routes/passpilot/kiosk.ts"), /activePasses\.map\(\(pass\) => \[pass\.studentId, withoutNullRuleOverride\(pass\)\]\)/);
  });
});

describe("PassPilot rules migration", () => {
  it("ships in the expand plan with immutable checksums", () => {
    assert.equal(passpilotRulesMigration.id, "passpilot-rules-20260929");
    assert.equal(passpilotRulesMigration.mode, "transactional");
    assert.equal(passpilotRulesMigration.checksum, sha256(PASSPILOT_RULES_SQL));
    assert.equal(passpilotRulesIndexesMigration.id, "passpilot-rules-indexes-online-20260929");
    assert.equal(passpilotRulesIndexesMigration.mode, "nontransactional");
    assert.equal(passpilotRulesIndexesMigration.checksum, sha256(PASSPILOT_RULES_INDEXES_CONTRACT));
    const ids = schoolPilot27Migrations.map((migration) => migration.id);
    const microsoft = ids.indexOf(microsoftSignInMigration.id);
    const rules = ids.indexOf(passpilotRulesMigration.id);
    const indexes = ids.indexOf(passpilotRulesIndexesMigration.id);
    const contract = ids.indexOf(STAFF_IDENTITY_CONTRACT_MIGRATION_IDS[0]);
    assert.ok(microsoft >= 0 && microsoft < rules && rules < indexes && indexes < contract);
    for (const migration of [passpilotRulesMigration, passpilotRulesIndexesMigration]) {
      assert.ok(schoolPilot27ExpandMigrations.some((candidate) => candidate.id === migration.id));
      assert.equal(ids.filter((id) => id === migration.id).length, 1);
    }
  });

  it("forces the canonical tenant policy on every rule table", () => {
    for (const table of RULE_TABLES) {
      assert.match(PASSPILOT_RULES_SQL, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(\\s+[\\s\\S]*?school_id TEXT NOT NULL CONSTRAINT \\w+ REFERENCES schools\\(id\\)`));
      assert.ok(PASSPILOT_RULES_SQL.includes(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`), table);
      assert.ok(PASSPILOT_RULES_SQL.includes(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`), table);
      assert.ok(PASSPILOT_RULES_SQL.includes(`DROP POLICY IF EXISTS tenant_isolation ON ${table};`), table);
      assert.ok(PASSPILOT_RULES_SQL.includes(
        `CREATE POLICY tenant_isolation ON ${table}\n  USING (${TENANT_PREDICATE})\n  WITH CHECK (${TENANT_PREDICATE});`,
      ), table);
    }
    for (const fk of ["pp_pass_limits_student_school_fk", "pp_encounter_restrictions_student_a_fk", "pp_encounter_restrictions_student_b_fk", "pp_pass_denials_student_school_fk"]) {
      assert.match(PASSPILOT_RULES_SQL, new RegExp(`CONSTRAINT ${fk} FOREIGN KEY \\(school_id, student(?:_[ab])?_id\\)\\s+REFERENCES students\\(school_id, id\\) ON DELETE CASCADE`));
    }
    assert.match(PASSPILOT_RULES_SQL, /ALTER TABLE passes ADD COLUMN IF NOT EXISTS rule_override_code TEXT;/);
    assert.match(PASSPILOT_RULES_SQL, /ADD CONSTRAINT passes_rule_override_code_check CHECK \([\s\S]*?\) NOT VALID;/);
  });

  it("builds the counting indexes online, one statement at a time", () => {
    for (const statement of [PASSPILOT_RULES_STUDENT_ISSUED_INDEX_SQL, PASSPILOT_RULES_ACTIVE_DESTINATION_INDEX_SQL]) {
      assert.match(statement, /^CREATE INDEX CONCURRENTLY IF NOT EXISTS /);
      assert.doesNotMatch(statement, /;/);
    }
    assert.match(PASSPILOT_RULES_STUDENT_ISSUED_INDEX_SQL, /passes_school_student_issued_idx\s+ON passes \(school_id, student_id, issued_at\)$/);
    assert.match(PASSPILOT_RULES_ACTIVE_DESTINATION_INDEX_SQL, /passes_school_destination_active_idx\s+ON passes \(school_id, destination\) WHERE status = 'active'$/);
    const startup = between(source("src/index.ts"), "export async function runStartupMigrations", "async function startServer");
    inOrder(startup, [
      "await pool.query(PASSPILOT_RULES_SQL);",
      "await pool.query(PASSPILOT_RULES_STUDENT_ISSUED_INDEX_SQL);",
      "await pool.query(PASSPILOT_RULES_ACTIVE_DESTINATION_INDEX_SQL);",
    ], "runStartupMigrations");
  });

  it("mirrors every named constraint and index in the pushed Drizzle schema", () => {
    const schema = source("src/schema/passpilot.ts");
    const names = new Set([
      ...[...PASSPILOT_RULES_SQL.matchAll(/CONSTRAINT (\w+)/g)].map((match) => match[1]!),
      ...[...PASSPILOT_RULES_SQL.matchAll(/INDEX IF NOT EXISTS (\w+)/g)].map((match) => match[1]!),
      "passes_school_student_issued_idx",
      "passes_school_destination_active_idx",
    ]);
    assert.ok(names.size >= 25);
    for (const name of names) assert.ok(schema.includes(`"${name}"`), `Drizzle schema must declare ${name}`);
    const drizzle = source("drizzle.config.ts");
    assert.match(drizzle, /"\.\/src\/schema\/passpilot\.ts"/, "the CI schema push must create the rule tables");
  });
});

describe("PassPilot rules operations", () => {
  it("documents the default-off flag", () => {
    assert.match(source(".env.example"), /^PASSPILOT_RULES_MODE=off$/m);
  });

  it("purges denials in their own locked scheduler job", () => {
    const scheduler = source("src/services/scheduler.ts");
    assert.match(scheduler, /scheduleLockedJob\("purgePasspilotPassDenials", purgePasspilotPassDenials\)/);
    assert.doesNotMatch(between(scheduler, "async function runHeavyJobsSerially", "export function startScheduler"), /purgePasspilotPassDenials/);
    assert.match(between(scheduler, "async function purgePasspilotPassDenials", "\n}"), /purgeExpiredPasspilotPassDenials\(schedulerPool\)/);
  });

  it("steps the rules router aside before authentication while off", () => {
    const router = source("src/routes/passpilot/rules.ts");
    inOrder(router, [
      'if (readPasspilotRulesMode() !== "on") return next("router");',
      "authenticate,",
      "requireSchoolContext,",
      "requireActiveSchool,",
      'requireProductLicense("PASSPILOT"),',
      'requirePassPilotRole("admin", "school_admin")',
    ], "rules router");
    const writes = router.match(/router\.(put|post|patch|delete)\(/g) || [];
    assert.equal(writes.length, 9);
    assert.equal((router.match(/await auditRules\(req, res, \{/g) || []).length, writes.length, "every write is audited");
    assert.match(router, /action: "passpilot\.rules\.update"/);
    assert.match(router, /\.strict\(\)/);
    assert.match(source("src/routes/index.ts"), /router\.use\("\/passpilot\/admin\/rules", passpilotRulesRoutes\);/);
  });

  it("states retention and privacy for denials and encounter restrictions", () => {
    const doc = source("docs/PASSPILOT_RULES.md");
    const wisp = source("docs/WISP.md");
    const privacy = source("schoolpilot-app/src/pages/legal/PrivacyPolicy.jsx");
    for (const [label, text] of [["docs", doc], ["WISP", wisp], ["privacy policy", privacy]] as const) {
      assert.match(text, /PassPilot rule denial records[^\n]*400 days/, label);
      assert.match(text, /encounter restrictions[^\n]*until an administrator deletes them/i, label);
    }
    assert.match(doc, /never stores? (?:or returns? )?the other student/i);
    assert.match(doc, /PASSPILOT_RULES_MODE/);
  });
});
