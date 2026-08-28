import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { runSchoolPilotMigrationLedger } from "../src/db/migrationLedger.js";
import {
  CLASSPILOT_27_EXPAND_SQL,
  CLASSPILOT_STUDENT_SESSION_RECOVERY_SQL,
  CLASSPILOT_STUDENT_SESSION_RECOVERY_VALIDATE_SQL,
  schoolPilot27Migrations,
} from "../src/db/migrations27.js";
import {
  CLASSPILOT_STUDENT_SESSION_RECOVERY_INDEXES_CONTRACT,
} from "../src/db/classpilotStudentSessionRecoveryIndexes.js";

function fakePool() {
  const rows = new Map<string, { checksum: string; status: string }>();
  const applied: string[] = [];
  const query = async (statement: string, values: unknown[] = []) => {
    if (/SELECT checksum, status FROM schema_migrations/.test(statement)) {
      const row = rows.get(String(values[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (/INSERT INTO schema_migrations/.test(statement)) {
      rows.set(String(values[0]), { checksum: String(values[1]), status: "running" });
    }
    if (/SET status = 'complete'/.test(statement)) {
      const row = rows.get(String(values[0]));
      if (row) row.status = "complete";
    }
    if (/SET status = 'failed'/.test(statement)) {
      const row = rows.get(String(values[0]));
      if (row) row.status = "failed";
    }
    if (statement === "APPLY") applied.push(statement);
    return { rows: [], rowCount: 0 };
  };
  const pool = {
    query,
    connect: async () => ({ query, release: () => {} }),
  };
  return { pool: pool as any, rows, applied };
}

test("production migration tasks bind the ledger to the exact deployed SHA", () => {
  const deploy = readFileSync(new URL("../scripts/deploy.sh", import.meta.url), "utf8");
  assert.match(deploy, /DEPLOY_APPLICATION_SHA="\$LOCAL_SHA" node -e/);
  assert.match(
    deploy,
    /\{ name: "GIT_SHA", value: process\.env\.DEPLOY_APPLICATION_SHA \}/
  );
});

test("migration ledger applies once and checksum-verifies every later run", async () => {
  const fixture = fakePool();
  const checksum = createHash("sha256").update("apply-once").digest("hex");
  const migration = {
    id: "test_apply_once",
    checksum,
    mode: "transactional" as const,
    apply: async (connection: any) => { await connection.query("APPLY"); },
  };
  const first = await runSchoolPilotMigrationLedger({
    pool: fixture.pool,
    migrations: [migration],
    applicationSha: "test-sha",
  });
  const second = await runSchoolPilotMigrationLedger({
    pool: fixture.pool,
    migrations: [migration],
    applicationSha: "test-sha",
  });
  assert.equal(first[0]?.status, "applied");
  assert.equal(second[0]?.status, "skipped");
  assert.equal(fixture.applied.length, 1);

  await assert.rejects(() => runSchoolPilotMigrationLedger({
    pool: fixture.pool,
    migrations: [{ ...migration, checksum: "0".repeat(64) }],
  }), /checksum mismatch/);
});

function nontransactionalLedgerFixture() {
  const rows = new Map<string, { checksum: string; status: string }>();
  const connectedClients: Array<{
    statements: string[];
    released: boolean;
    query: (statement: string, values?: unknown[]) => Promise<any>;
    release: () => void;
  }> = [];
  const poolQuery = async (statement: string, values: unknown[] = []) => {
    if (/SELECT checksum, status FROM schema_migrations/.test(statement)) {
      const row = rows.get(String(values[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (/INSERT INTO schema_migrations/.test(statement)) {
      rows.set(String(values[0]), { checksum: String(values[1]), status: "running" });
    }
    if (/SET status = 'complete'/.test(statement)) {
      const row = rows.get(String(values[0]));
      if (row) row.status = "complete";
    }
    if (/SET status = 'failed'/.test(statement)) {
      const row = rows.get(String(values[0]));
      if (row) row.status = "failed";
    }
    return { rows: [], rowCount: 0 };
  };
  const pool: Pool = Object.assign(Object.create(Pool.prototype), {
    query: poolQuery,
    connect: async () => {
      const client = {
        statements: [] as string[],
        released: false,
        query: async (statement: string, values: unknown[] = []) => {
          client.statements.push(statement);
          return poolQuery(statement, values);
        },
        release: () => { client.released = true; },
      };
      connectedClients.push(client);
      return client;
    },
  });
  return { connectedClients, pool, rows };
}

test("nontransactional migrations use one unwrapped client and release it on success", async () => {
  const fixture = nontransactionalLedgerFixture();
  const checksum = createHash("sha256").update("online-success").digest("hex");
  let applyConnection: unknown;
  const result = await runSchoolPilotMigrationLedger({
    pool: fixture.pool,
    applicationSha: "test-sha",
    migrations: [{
      id: "test_online_success",
      checksum,
      mode: "nontransactional",
      apply: async (connection) => {
        applyConnection = connection;
        await connection.query("ONLINE APPLY");
      },
    }],
  });

  assert.equal(result[0]?.status, "applied");
  assert.equal(fixture.connectedClients.length, 2, "ledger lock plus migration client");
  const migrationClient = fixture.connectedClients[1];
  assert.equal(applyConnection, migrationClient);
  assert.equal(migrationClient?.released, true);
  assert.deepEqual(migrationClient?.statements, ["ONLINE APPLY"]);
  assert.ok(
    fixture.connectedClients.every((client) =>
      client.statements.every((statement) => !/^(BEGIN|COMMIT)$/i.test(statement))
    )
  );
});

test("nontransactional migrations release their client and mark failure without transaction wrappers", async () => {
  const fixture = nontransactionalLedgerFixture();
  const checksum = createHash("sha256").update("online-failure").digest("hex");
  const failure = new Error("synthetic online migration failure");

  await assert.rejects(
    () => runSchoolPilotMigrationLedger({
      pool: fixture.pool,
      migrations: [{
        id: "test_online_failure",
        checksum,
        mode: "nontransactional",
        apply: async (connection) => {
          await connection.query("ONLINE APPLY");
          throw failure;
        },
      }],
    }),
    (error) => error === failure
  );

  assert.equal(fixture.connectedClients.length, 2);
  assert.equal(fixture.connectedClients[1]?.released, true);
  assert.deepEqual(fixture.connectedClients[1]?.statements, ["ONLINE APPLY"]);
  assert.equal(fixture.rows.get("test_online_failure")?.status, "failed");
  assert.ok(
    fixture.connectedClients.every((client) =>
      client.statements.every((statement) => !/^(BEGIN|COMMIT)$/i.test(statement))
    )
  );
});

test("ClassPilot 2.7 expand migration checksum covers the exact additive SQL", () => {
  assert.equal(
    schoolPilot27Migrations[0]?.checksum,
    createHash("sha256").update(CLASSPILOT_27_EXPAND_SQL).digest("hex")
  );
  assert.match(CLASSPILOT_27_EXPAND_SQL, /ADD COLUMN IF NOT EXISTS report_version/);
  assert.match(CLASSPILOT_27_EXPAND_SQL, /ADD COLUMN IF NOT EXISTS client_message_id/);
  assert.match(CLASSPILOT_27_EXPAND_SQL, /chat_messages_student_client_unique/);
});

test("ClassPilot manual student-session recovery is checksum-ledgered and additive", () => {
  const recoveryMigrations = schoolPilot27Migrations.filter(
    (candidate) => candidate.id.includes("classpilot_student_session")
  );
  assert.equal(recoveryMigrations.length, 3);
  const [expand, validate, indexes] = recoveryMigrations;
  assert.ok(expand);
  assert.ok(validate);
  assert.ok(indexes);
  assert.equal(
    expand.checksum,
    createHash("sha256").update(CLASSPILOT_STUDENT_SESSION_RECOVERY_SQL).digest("hex")
  );
  assert.equal(expand.mode, "transactional");
  assert.equal(
    validate.checksum,
    createHash("sha256")
      .update(CLASSPILOT_STUDENT_SESSION_RECOVERY_VALIDATE_SQL)
      .digest("hex")
  );
  assert.equal(validate.mode, "transactional");
  assert.equal(
    indexes.checksum,
    createHash("sha256")
      .update(CLASSPILOT_STUDENT_SESSION_RECOVERY_INDEXES_CONTRACT)
      .digest("hex")
  );
  assert.equal(indexes.mode, "nontransactional");
  assert.match(CLASSPILOT_STUDENT_SESSION_RECOVERY_SQL, /auth_kind TEXT NOT NULL DEFAULT 'legacy'/);
  assert.match(CLASSPILOT_STUDENT_SESSION_RECOVERY_SQL, /manual_lease_expires_at TIMESTAMPTZ/);
  assert.match(CLASSPILOT_STUDENT_SESSION_RECOVERY_SQL, /session_recovery_token_hash VARCHAR\(64\)/);
  assert.match(CLASSPILOT_STUDENT_SESSION_RECOVERY_SQL, /NOT VALID/);
  assert.doesNotMatch(CLASSPILOT_STUDENT_SESSION_RECOVERY_SQL, /CREATE INDEX/);
  assert.match(CLASSPILOT_STUDENT_SESSION_RECOVERY_VALIDATE_SQL, /VALIDATE CONSTRAINT student_sessions_auth_kind_check/);
  assert.match(CLASSPILOT_STUDENT_SESSION_RECOVERY_INDEXES_CONTRACT, /student_sessions_manual_lease_expiry_idx/);
  assert.match(CLASSPILOT_STUDENT_SESSION_RECOVERY_INDEXES_CONTRACT, /student_sessions_recovery_token_hash_unique/);
});

test("ClassPilot Phase-A recovery migration preserves old writers and freezes auth kind after insert", () => {
  assert.match(CLASSPILOT_STUDENT_SESSION_RECOVERY_SQL, /DROP TRIGGER IF EXISTS student_sessions_reject_legacy_insert/);
  assert.match(CLASSPILOT_STUDENT_SESSION_RECOVERY_SQL, /DROP FUNCTION IF EXISTS reject_legacy_student_session_insert/);
  assert.doesNotMatch(CLASSPILOT_STUDENT_SESSION_RECOVERY_SQL, /BEFORE INSERT ON student_sessions/);
  assert.doesNotMatch(CLASSPILOT_STUDENT_SESSION_RECOVERY_SQL, /CLASSPILOT_LEGACY_SESSION_INSERT_FORBIDDEN/);
  assert.match(
    CLASSPILOT_STUDENT_SESSION_RECOVERY_SQL,
    /BEFORE UPDATE OF auth_kind ON student_sessions/
  );
  assert.match(
    CLASSPILOT_STUDENT_SESSION_RECOVERY_SQL,
    /NEW\.auth_kind IS DISTINCT FROM OLD\.auth_kind/
  );
  assert.match(CLASSPILOT_STUDENT_SESSION_RECOVERY_SQL, /ERRCODE = 'CP002'/);
  assert.match(
    CLASSPILOT_STUDENT_SESSION_RECOVERY_SQL,
    /MESSAGE = 'CLASSPILOT_SESSION_AUTH_KIND_IMMUTABLE'/
  );
});

test("production one-off mode is ledger-only and legacy convergence fails closed", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const oneOffStart = source.indexOf("async function runMigrationsAndExit");
  const oneOffEnd = source.indexOf("async function runLegacyMigrationsAndExit", oneOffStart);
  assert.notEqual(oneOffStart, -1);
  assert.notEqual(oneOffEnd, -1);
  const oneOff = source.slice(oneOffStart, oneOffEnd);
  assert.match(oneOff, /await runVersionedMigrations\(\)/);
  assert.doesNotMatch(oneOff, /runStartupMigrations/);

  const legacyStart = source.indexOf("export async function runStartupMigrations");
  assert.notEqual(legacyStart, -1);
  const legacyGuard = source.slice(legacyStart, legacyStart + 500);
  assert.match(legacyGuard, /NODE_ENV === "production"/);
  assert.match(legacyGuard, /LEGACY_STARTUP_MIGRATIONS_FORBIDDEN/);
});
