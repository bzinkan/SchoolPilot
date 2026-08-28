import test from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import {
  CLASSPILOT_MANUAL_LEASE_BUILD_INDEX_NAME,
  CLASSPILOT_MANUAL_LEASE_INDEX_NAME,
  CLASSPILOT_RECOVERY_TOKEN_BUILD_INDEX_NAME,
  CLASSPILOT_RECOVERY_TOKEN_INDEX_NAME,
  ensureClasspilotStudentSessionRecoveryIndexesOnline,
  isExpectedClasspilotManualLeaseIndex,
  isExpectedClasspilotRecoveryTokenIndex,
  type ClasspilotStudentSessionRecoveryIndexState,
} from "../src/db/classpilotStudentSessionRecoveryIndexes.js";

function leaseState(
  name = CLASSPILOT_MANUAL_LEASE_INDEX_NAME
): ClasspilotStudentSessionRecoveryIndexState {
  return {
    access_method: "btree",
    index_definition:
      `CREATE INDEX ${name} ON public.student_sessions USING btree `
      + `(manual_lease_expires_at) WHERE ((auth_kind = 'manual_shared'::text) `
      + `AND (is_active = true) AND (ended_at IS NULL))`,
    index_predicate:
      "((auth_kind = 'manual_shared'::text) AND (is_active = true) AND (ended_at IS NULL))",
    indislive: true,
    indisready: true,
    indisunique: false,
    indisvalid: true,
    is_constraint_owned: false,
    is_expression_free: true,
    key_columns: ["manual_lease_expires_at"],
    key_count: 1,
    table_name: "student_sessions",
    total_column_count: 1,
  };
}

function recoveryState(
  name = CLASSPILOT_RECOVERY_TOKEN_INDEX_NAME
): ClasspilotStudentSessionRecoveryIndexState {
  return {
    access_method: "btree",
    index_definition:
      `CREATE UNIQUE INDEX ${name} ON public.student_sessions USING btree `
      + `(session_recovery_token_hash) WHERE (session_recovery_token_hash IS NOT NULL)`,
    index_predicate: "(session_recovery_token_hash IS NOT NULL)",
    indislive: true,
    indisready: true,
    indisunique: true,
    indisvalid: true,
    is_constraint_owned: false,
    is_expression_free: true,
    key_columns: ["session_recovery_token_hash"],
    key_count: 1,
    table_name: "student_sessions",
    total_column_count: 1,
  };
}

test("recovery index verification covers table, columns, predicate, uniqueness, and catalog readiness", () => {
  assert.equal(isExpectedClasspilotManualLeaseIndex(leaseState()), true);
  assert.equal(isExpectedClasspilotRecoveryTokenIndex(recoveryState()), true);

  for (const invalid of [
    { table_name: "heartbeats" },
    { key_columns: ["last_seen_at"] },
    { index_predicate: "manual_lease_expires_at IS NOT NULL" },
    { indisunique: true },
    { indisvalid: false },
    { indisready: false },
    { indislive: false },
    { access_method: "hash" },
    { is_constraint_owned: true },
    { is_expression_free: false },
  ]) {
    assert.equal(
      isExpectedClasspilotManualLeaseIndex({ ...leaseState(), ...invalid }),
      false,
      `manual lease index must reject ${Object.keys(invalid)[0]}`
    );
  }

  for (const invalid of [
    { table_name: "heartbeats" },
    { key_columns: ["manual_lease_expires_at"] },
    { index_predicate: "session_recovery_token_hash IS NULL" },
    { indisunique: false },
    { indisvalid: false },
    { indisready: false },
    { indislive: false },
  ]) {
    assert.equal(
      isExpectedClasspilotRecoveryTokenIndex({ ...recoveryState(), ...invalid }),
      false,
      `recovery token index must reject ${Object.keys(invalid)[0]}`
    );
  }
});

function onlineIndexFixture() {
  const indexes = new Map<string, ClasspilotStudentSessionRecoveryIndexState>();
  const statements: string[] = [];
  const client = {
    query: async (statement: string, values: unknown[] = []) => {
      const normalized = statement.replace(/\s+/g, " ").trim();
      statements.push(normalized);
      if (normalized === "SHOW statement_timeout") {
        return { rows: [{ statement_timeout: "0" }], rowCount: 1 };
      }
      if (normalized === "SHOW lock_timeout") {
        return { rows: [{ lock_timeout: "0" }], rowCount: 1 };
      }
      if (normalized.includes("pg_try_advisory_lock")) {
        return { rows: [{ acquired: true }], rowCount: 1 };
      }
      if (normalized.includes("pg_get_indexdef(index_state.indexrelid)")) {
        const state = indexes.get(String(values[0]));
        return { rows: state ? [state] : [], rowCount: state ? 1 : 0 };
      }
      if (normalized.startsWith("CREATE INDEX CONCURRENTLY")) {
        indexes.set(
          CLASSPILOT_MANUAL_LEASE_BUILD_INDEX_NAME,
          leaseState(CLASSPILOT_MANUAL_LEASE_BUILD_INDEX_NAME)
        );
      }
      if (normalized.startsWith("CREATE UNIQUE INDEX CONCURRENTLY")) {
        indexes.set(
          CLASSPILOT_RECOVERY_TOKEN_BUILD_INDEX_NAME,
          recoveryState(CLASSPILOT_RECOVERY_TOKEN_BUILD_INDEX_NAME)
        );
      }
      const drop = normalized.match(/^DROP INDEX CONCURRENTLY IF EXISTS public\.([a-z0-9_]+)$/i);
      if (drop?.[1]) indexes.delete(drop[1]);
      const rename = normalized.match(
        /^ALTER INDEX public\.([a-z0-9_]+) RENAME TO ([a-z0-9_]+)$/i
      );
      if (rename?.[1] && rename[2]) {
        const state = indexes.get(rename[1]);
        if (state) {
          indexes.delete(rename[1]);
          indexes.set(rename[2], {
            ...state,
            index_definition: state.index_definition.replace(rename[1], rename[2]),
          });
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return {
    client: client as Pick<PoolClient, "query">,
    indexes,
    statements,
  };
}

test("online recovery index migration replaces invalid canonical/build indexes and is retry-safe", async () => {
  const fixture = onlineIndexFixture();
  fixture.indexes.set(CLASSPILOT_MANUAL_LEASE_INDEX_NAME, {
    ...leaseState(),
    indisvalid: false,
  });
  fixture.indexes.set(CLASSPILOT_MANUAL_LEASE_BUILD_INDEX_NAME, {
    ...leaseState(CLASSPILOT_MANUAL_LEASE_BUILD_INDEX_NAME),
    key_columns: ["last_seen_at"],
  });
  fixture.indexes.set(CLASSPILOT_RECOVERY_TOKEN_INDEX_NAME, {
    ...recoveryState(),
    index_predicate: "session_recovery_token_hash IS NULL",
  });
  fixture.indexes.set(CLASSPILOT_RECOVERY_TOKEN_BUILD_INDEX_NAME, {
    ...recoveryState(CLASSPILOT_RECOVERY_TOKEN_BUILD_INDEX_NAME),
    indisready: false,
  });

  await ensureClasspilotStudentSessionRecoveryIndexesOnline(fixture.client);

  assert.equal(
    isExpectedClasspilotManualLeaseIndex(
      fixture.indexes.get(CLASSPILOT_MANUAL_LEASE_INDEX_NAME)
    ),
    true
  );
  assert.equal(
    isExpectedClasspilotRecoveryTokenIndex(
      fixture.indexes.get(CLASSPILOT_RECOVERY_TOKEN_INDEX_NAME)
    ),
    true
  );
  assert.equal(fixture.indexes.has(CLASSPILOT_MANUAL_LEASE_BUILD_INDEX_NAME), false);
  assert.equal(fixture.indexes.has(CLASSPILOT_RECOVERY_TOKEN_BUILD_INDEX_NAME), false);
  assert.ok(
    fixture.statements.some((statement) =>
      statement === `DROP INDEX CONCURRENTLY IF EXISTS public.${CLASSPILOT_MANUAL_LEASE_BUILD_INDEX_NAME}`
    )
  );
  assert.ok(
    fixture.statements.some((statement) =>
      statement.startsWith(
        `CREATE UNIQUE INDEX CONCURRENTLY ${CLASSPILOT_RECOVERY_TOKEN_BUILD_INDEX_NAME}`
      )
    )
  );

  const createCount = fixture.statements.filter((statement) =>
    /^CREATE (?:UNIQUE )?INDEX CONCURRENTLY/.test(statement)
  ).length;
  await ensureClasspilotStudentSessionRecoveryIndexesOnline(fixture.client);
  assert.equal(
    fixture.statements.filter((statement) =>
      /^CREATE (?:UNIQUE )?INDEX CONCURRENTLY/.test(statement)
    ).length,
    createCount,
    "a verified retry must not rebuild either canonical index"
  );
});
