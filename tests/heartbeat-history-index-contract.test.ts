import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PoolClient } from "pg";
import {
  HEARTBEAT_HISTORY_BUILD_INDEX_NAME,
  HEARTBEAT_HISTORY_INDEX_NAME,
  HEARTBEAT_STUDENT_HISTORY_BUILD_INDEX_NAME,
  HEARTBEAT_STUDENT_HISTORY_INDEX_NAME,
  ensureHeartbeatHistoryIndexOnline,
  isExpectedHeartbeatHistoryIndex,
  isExpectedHeartbeatStudentHistoryIndex,
  type HeartbeatHistoryIndexState,
} from "../src/db/heartbeatHistoryIndex.js";

const exactState = (name: string): HeartbeatHistoryIndexState => ({
  access_method: "btree",
  index_definition: `CREATE INDEX ${name} ON public.heartbeats USING btree (school_id, device_id, \"timestamp\" DESC)`,
  indislive: true,
  indisready: true,
  indisunique: false,
  indisvalid: true,
  is_constraint_owned: false,
  is_plain: true,
  key_columns: ["school_id", "device_id", "timestamp"],
  key_descending: [false, false, true],
  key_count: 3,
  total_column_count: 3,
  table_name: "heartbeats",
});

const ascendingState = (name: string): HeartbeatHistoryIndexState => ({
  ...exactState(name),
  index_definition: `CREATE INDEX ${name} ON public.heartbeats USING btree (school_id, device_id, \"timestamp\")`,
  key_descending: [false, false, false],
});

const studentExactState = (name: string): HeartbeatHistoryIndexState => ({
  ...exactState(name),
  index_definition: `CREATE INDEX ${name} ON public.heartbeats USING btree (school_id, device_id, student_id, \"timestamp\" DESC)`,
  key_columns: ["school_id", "device_id", "student_id", "timestamp"],
  key_descending: [false, false, false, true],
  key_count: 4,
  total_column_count: 4,
});

class FakeIndexClient {
  readonly statements: string[] = [];
  readonly states = new Map<string, HeartbeatHistoryIndexState>([
    [
      HEARTBEAT_STUDENT_HISTORY_INDEX_NAME,
      studentExactState(HEARTBEAT_STUDENT_HISTORY_INDEX_NAME),
    ],
  ]);
  readonly statementTimeoutValues: string[] = [];
  advisoryLockAcquired = true;
  failOnStatementPattern: RegExp | undefined;
  makeCreatedBuildInvalid = false;
  statementTimeout = "15s";

  async query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    const normalized = text.replace(/\s+/g, " ").trim();
    this.statements.push(normalized);

    if (this.failOnStatementPattern?.test(normalized)) {
      throw new Error("canceling statement due to statement timeout");
    }

    if (normalized === "SHOW statement_timeout") {
      return { rows: [{ statement_timeout: this.statementTimeout }] };
    }

    if (normalized.startsWith("SELECT pg_try_advisory_lock")) {
      return { rows: [{ acquired: this.advisoryLockAcquired }] };
    }

    if (normalized.startsWith("SELECT set_config('statement_timeout'")) {
      this.statementTimeout = String(params?.[0]);
      this.statementTimeoutValues.push(this.statementTimeout);
      return { rows: [{ set_config: this.statementTimeout }] };
    }

    if (normalized.includes("pg_get_indexdef(i.indexrelid)")) {
      const name = String(params?.[0]);
      const state = this.states.get(name);
      return { rows: state ? [state] : [] };
    }

    if (normalized.startsWith("CREATE INDEX CONCURRENTLY")) {
      const studentScoped = normalized.includes(
        HEARTBEAT_STUDENT_HISTORY_BUILD_INDEX_NAME
      );
      const buildName = studentScoped
        ? HEARTBEAT_STUDENT_HISTORY_BUILD_INDEX_NAME
        : HEARTBEAT_HISTORY_BUILD_INDEX_NAME;
      const created = studentScoped
        ? studentExactState(buildName)
        : exactState(buildName);
      if (this.makeCreatedBuildInvalid) {
        created.indisvalid = false;
      }
      this.states.set(buildName, created);
      return { rows: [] };
    }

    if (normalized.startsWith("DROP INDEX CONCURRENTLY")) {
      if (normalized.includes(HEARTBEAT_STUDENT_HISTORY_BUILD_INDEX_NAME)) {
        this.states.delete(HEARTBEAT_STUDENT_HISTORY_BUILD_INDEX_NAME);
      } else if (normalized.includes(HEARTBEAT_STUDENT_HISTORY_INDEX_NAME)) {
        this.states.delete(HEARTBEAT_STUDENT_HISTORY_INDEX_NAME);
      } else if (normalized.includes(HEARTBEAT_HISTORY_BUILD_INDEX_NAME)) {
        this.states.delete(HEARTBEAT_HISTORY_BUILD_INDEX_NAME);
      } else if (normalized.includes(HEARTBEAT_HISTORY_INDEX_NAME)) {
        this.states.delete(HEARTBEAT_HISTORY_INDEX_NAME);
      }
      return { rows: [] };
    }

    if (normalized.startsWith("ALTER INDEX")) {
      const studentScoped = normalized.includes(
        HEARTBEAT_STUDENT_HISTORY_BUILD_INDEX_NAME
      );
      const buildName = studentScoped
        ? HEARTBEAT_STUDENT_HISTORY_BUILD_INDEX_NAME
        : HEARTBEAT_HISTORY_BUILD_INDEX_NAME;
      const canonicalName = studentScoped
        ? HEARTBEAT_STUDENT_HISTORY_INDEX_NAME
        : HEARTBEAT_HISTORY_INDEX_NAME;
      const build = this.states.get(buildName);
      if (!build) throw new Error("test fixture build index missing");
      this.states.delete(buildName);
      this.states.set(
        canonicalName,
        studentScoped
          ? studentExactState(canonicalName)
          : exactState(canonicalName)
      );
      return { rows: [] };
    }

    return { rows: [] };
  }
}

const asPoolClient = (client: FakeIndexClient): PoolClient =>
  client as unknown as PoolClient;

describe("heartbeat teacher-tile history index contract", () => {
  it("defines the exact descending timestamp order in the Drizzle schema", () => {
    const schemaSource = readFileSync(
      new URL("../src/schema/classpilot.ts", import.meta.url),
      "utf8"
    );
    const tableStart = schemaSource.indexOf("export const heartbeats");
    const tableEnd = schemaSource.indexOf(
      "export type Heartbeat",
      tableStart
    );
    assert.ok(tableStart >= 0 && tableEnd > tableStart);
    const tableSource = schemaSource.slice(tableStart, tableEnd);

    assert.match(
      tableSource,
      /index\("heartbeats_school_device_timestamp_idx"\)\.on\(\s*table\.schoolId,\s*table\.deviceId,\s*table\.timestamp\.desc\(\)\s*\)/
    );
    assert.match(
      tableSource,
      /index\("heartbeats_school_device_student_timestamp_idx"\)\.on\(\s*table\.schoolId,\s*table\.deviceId,\s*table\.studentId,\s*table\.timestamp\.desc\(\)\s*\)/
    );
  });

  it("keeps the student-scoped history query aligned with the four-key index", () => {
    const source = readFileSync(
      new URL("../src/services/storage.ts", import.meta.url),
      "utf8"
    );
    const queryStart = source.indexOf(
      "export async function getHeartbeatsByDevice("
    );
    const queryEnd = source.indexOf(
      "export async function getHeartbeatsByDeviceInRange(",
      queryStart
    );
    assert.ok(queryStart >= 0 && queryEnd > queryStart);
    const querySource = source.slice(queryStart, queryEnd);

    assert.match(querySource, /eq\(heartbeats\.schoolId, schoolId\)/);
    assert.match(querySource, /eq\(heartbeats\.deviceId, deviceId\)/);
    assert.match(
      querySource,
      /conditions\.push\(inArray\(heartbeats\.studentId, authorizedStudentIds\)\)/
    );
    assert.match(querySource, /orderBy\(desc\(heartbeats\.timestamp\)\)/);
    assert.match(querySource, /authorizedStudentIds\?\.length === 0/);
  });

  it("runs the online index amendment only from migrations-only mode", () => {
    const source = readFileSync(
      new URL("../src/index.ts", import.meta.url),
      "utf8"
    );
    const sectionStart = source.indexOf(
      "// Teacher tile history requires exact mixed-order indexes"
    );
    const sectionEnd = source.indexOf(
      "// Teacher tiles authorize by device id",
      sectionStart
    );
    assert.ok(sectionStart >= 0 && sectionEnd > sectionStart);
    const section = source.slice(sectionStart, sectionEnd);

    assert.match(
      section,
      /if \(migrationsOnly\(\)\) \{[\s\S]*ensureHeartbeatHistoryIndexOnline\(heartbeatIndexClient\)/
    );
    assert.match(
      section,
      /heartbeatIndexClient\.release\(heartbeatIndexClientError\)/
    );
    assert.match(section, /catch \(err\)[\s\S]*throw err/);
  });

  it("keeps the deployment controller attached to long online migrations", () => {
    const deploySource = readFileSync(
      new URL("../scripts/deploy.sh", import.meta.url),
      "utf8"
    );

    assert.match(deploySource, /MIGRATION_TASK_WAIT_SECONDS=3600/);
    assert.match(deploySource, /MIGRATION_TASK_POLL_SECONDS=15/);
    assert.match(
      deploySource,
      /wait_for_migration_task_stopped\(\)[\s\S]*ecs describe-tasks[\s\S]*lastStatus/
    );
    assert.match(
      deploySource,
      /wait_for_migration_task_stopped\(\)[\s\S]*ecs stop-task/
    );
    assert.match(
      deploySource,
      /deadline_exceeded=true[\s\S]*if \[\[ "\$deadline_exceeded" == true \]\]; then\s*return 124/
    );
    assert.match(deploySource, /--cli-connect-timeout 10/);
    assert.match(deploySource, /--cli-read-timeout 30/);
    assert.doesNotMatch(
      deploySource,
      /^\s*aws ecs wait tasks-stopped/m,
      "the stock ten-minute waiter can abandon a still-running online index build"
    );
    assert.match(
      deploySource,
      /wait_for_migration_task_stopped "\$MIGRATION_TASK_ARN"[\s\S]*MIGRATION_WAIT_RESULT=\$\?[\s\S]*MIGRATION_WAIT_RESULT" -eq 124[\s\S]*exit 1/
    );
  });

  it("uses pg_index plus pg_get_indexdef and has no blocking build fallback", () => {
    const source = readFileSync(
      new URL("../src/db/heartbeatHistoryIndex.ts", import.meta.url),
      "utf8"
    );

    assert.match(source, /pg_get_indexdef\(i\.indexrelid\)/);
    assert.match(source, /i\.indisvalid/);
    assert.match(source, /i\.indislive/);
    assert.match(source, /index_constraint\.conindid = i\.indexrelid/);
    assert.match(source, /i\.indisready/);
    assert.match(source, /i\.indnkeyatts/);
    assert.match(source, /i\.indnatts/);
    assert.match(source, /i\.indoption/);
    assert.match(source, /i\.indpred IS NULL AND i\.indexprs IS NULL/);
    assert.match(source, /SHOW statement_timeout/);
    assert.match(source, /HEARTBEAT_HISTORY_BUILD_TIMEOUT = "8min"/);
    assert.match(source, /pg_try_advisory_lock\(hashtext\(\$1\)\)/);
    assert.doesNotMatch(
      source,
      /SELECT pg_advisory_lock\(hashtext\(\$1\)\)/,
      "duplicate migrations must fail immediately instead of waiting past the ECS controller"
    );
    assert.match(
      source,
      /set_config\('statement_timeout', \$1, false\)/
    );
    assert.match(
      source,
      /CREATE INDEX CONCURRENTLY \$\{spec\.buildName\} ON public\.heartbeats USING btree \(\$\{spec\.createColumnsSql\}\)/
    );
    assert.match(
      source,
      /createColumnsSql: "school_id, device_id, student_id, timestamp DESC"/
    );
    assert.doesNotMatch(
      source,
      /CREATE INDEX(?: IF NOT EXISTS)? \$\{spec\.buildName\}/,
      "the migration must never fall back to a blocking index build"
    );
    assert.match(source, /WHERE n\.nspname = 'public'/);
    assert.match(source, /ANALYZE public\.heartbeats/);
    assert.equal(
      [...source.matchAll(/ANALYZE public\.heartbeats/g)].length,
      1,
      "both exact indexes must be verified before one shared ANALYZE"
    );
    assert.match(
      source,
      /DROP INDEX CONCURRENTLY IF EXISTS public\.\$\{spec\.canonicalName\}/
    );
    assert.match(
      source,
      /ALTER INDEX public\.\$\{spec\.buildName\}/
    );
  });

  it("rejects ascending, invalid, included-column, and contradictory definitions", () => {
    assert.equal(
      isExpectedHeartbeatHistoryIndex(exactState(HEARTBEAT_HISTORY_INDEX_NAME)),
      true
    );
    assert.equal(
      isExpectedHeartbeatHistoryIndex(
        ascendingState(HEARTBEAT_HISTORY_INDEX_NAME)
      ),
      false
    );

    const invalid = exactState(HEARTBEAT_HISTORY_INDEX_NAME);
    invalid.indisvalid = false;
    assert.equal(isExpectedHeartbeatHistoryIndex(invalid), false);

    const dead = exactState(HEARTBEAT_HISTORY_INDEX_NAME);
    dead.indislive = false;
    assert.equal(isExpectedHeartbeatHistoryIndex(dead), false);

    const constraintOwned = exactState(HEARTBEAT_HISTORY_INDEX_NAME);
    constraintOwned.is_constraint_owned = true;
    assert.equal(isExpectedHeartbeatHistoryIndex(constraintOwned), false);

    const included = exactState(HEARTBEAT_HISTORY_INDEX_NAME);
    included.total_column_count = 4;
    assert.equal(isExpectedHeartbeatHistoryIndex(included), false);

    const contradictory = exactState(HEARTBEAT_HISTORY_INDEX_NAME);
    contradictory.index_definition = contradictory.index_definition.replace(
      " DESC",
      ""
    );
    assert.equal(isExpectedHeartbeatHistoryIndex(contradictory), false);

    assert.equal(
      isExpectedHeartbeatStudentHistoryIndex(
        studentExactState(HEARTBEAT_STUDENT_HISTORY_INDEX_NAME)
      ),
      true
    );
    const wrongStudentOrder = studentExactState(
      HEARTBEAT_STUDENT_HISTORY_INDEX_NAME
    );
    wrongStudentOrder.key_columns = [
      "school_id",
      "student_id",
      "device_id",
      "timestamp",
    ];
    assert.equal(
      isExpectedHeartbeatStudentHistoryIndex(wrongStudentOrder),
      false
    );
    const contradictoryStudent = studentExactState(
      HEARTBEAT_STUDENT_HISTORY_INDEX_NAME
    );
    contradictoryStudent.index_definition =
      contradictoryStudent.index_definition.replace("student_id, ", "");
    assert.equal(
      isExpectedHeartbeatStudentHistoryIndex(contradictoryStudent),
      false
    );
  });

  it("fails closed without DDL when another migration holds the advisory lock", async () => {
    const client = new FakeIndexClient();
    client.advisoryLockAcquired = false;
    client.states.set(
      HEARTBEAT_HISTORY_INDEX_NAME,
      ascendingState(HEARTBEAT_HISTORY_INDEX_NAME)
    );

    await assert.rejects(
      ensureHeartbeatHistoryIndexOnline(asPoolClient(client)),
      /already running on another session/
    );

    assert.equal(
      client.statements.some((statement) =>
        /^(?:CREATE|DROP|ALTER|ANALYZE)\b/.test(statement)
      ),
      false
    );
    assert.deepEqual(client.statementTimeoutValues, []);
    assert.equal(client.statementTimeout, "15s");
  });

  it("does not mutate contradictory or constraint-owned canonical indexes", async () => {
    const contradictoryStates: HeartbeatHistoryIndexState[] = [];
    const wrongTable = ascendingState(HEARTBEAT_HISTORY_INDEX_NAME);
    wrongTable.table_name = "unrelated_table";
    contradictoryStates.push(wrongTable);
    const constraintOwned = ascendingState(HEARTBEAT_HISTORY_INDEX_NAME);
    constraintOwned.is_constraint_owned = true;
    contradictoryStates.push(constraintOwned);

    for (const contradictory of contradictoryStates) {
      const client = new FakeIndexClient();
      client.states.set(HEARTBEAT_HISTORY_INDEX_NAME, contradictory);

      await assert.rejects(
        ensureHeartbeatHistoryIndexOnline(asPoolClient(client)),
        /refusing online replacement/
      );
      assert.equal(
        client.statements.some((statement) =>
          /^(?:CREATE|DROP|ALTER|ANALYZE)\b/.test(statement)
        ),
        false
      );
    }
  });

  it("does not drop a reserved build-name index owned by another table", async () => {
    const client = new FakeIndexClient();
    client.states.set(
      HEARTBEAT_HISTORY_INDEX_NAME,
      ascendingState(HEARTBEAT_HISTORY_INDEX_NAME)
    );
    const wrongBuild = exactState(HEARTBEAT_HISTORY_BUILD_INDEX_NAME);
    wrongBuild.table_name = "unrelated_table";
    client.states.set(HEARTBEAT_HISTORY_BUILD_INDEX_NAME, wrongBuild);

    await assert.rejects(
      ensureHeartbeatHistoryIndexOnline(asPoolClient(client)),
      /belongs to public\.unrelated_table/
    );
    assert.equal(
      client.statements.some((statement) =>
        /^(?:CREATE|DROP|ALTER|ANALYZE)\b/.test(statement)
      ),
      false
    );
  });

  it("keeps the ASC index until a concurrently built replacement verifies", async () => {
    const client = new FakeIndexClient();
    client.states.set(
      HEARTBEAT_HISTORY_INDEX_NAME,
      ascendingState(HEARTBEAT_HISTORY_INDEX_NAME)
    );

    await ensureHeartbeatHistoryIndexOnline(asPoolClient(client));

    assert.equal(
      isExpectedHeartbeatHistoryIndex(
        client.states.get(HEARTBEAT_HISTORY_INDEX_NAME)
      ),
      true
    );
    assert.equal(
      client.states.has(HEARTBEAT_HISTORY_BUILD_INDEX_NAME),
      false
    );
    const createPosition = client.statements.findIndex((statement) =>
      statement.startsWith("CREATE INDEX CONCURRENTLY")
    );
    const dropCanonicalPosition = client.statements.findIndex(
      (statement) =>
        statement.startsWith("DROP INDEX CONCURRENTLY") &&
        statement.endsWith(HEARTBEAT_HISTORY_INDEX_NAME)
    );
    const renamePosition = client.statements.findIndex((statement) =>
      statement.startsWith("ALTER INDEX")
    );
    assert.ok(createPosition >= 0);
    assert.ok(dropCanonicalPosition > createPosition);
    assert.ok(renamePosition > dropCanonicalPosition);
    assert.equal(client.statementTimeout, "15s");
    const relaxedPosition = client.statements.findIndex(
      (statement) =>
        statement === "SELECT set_config('statement_timeout', $1, false)"
    );
    const restoredPosition = client.statements.findLastIndex(
      (statement) =>
        statement === "SELECT set_config('statement_timeout', $1, false)"
    );
    assert.ok(relaxedPosition >= 0 && relaxedPosition < createPosition);
    assert.ok(restoredPosition > renamePosition);
    assert.deepEqual(client.statementTimeoutValues, ["8min", "15s"]);
    assert.ok(
      client.statements.includes("ANALYZE public.heartbeats"),
      "the replacement must refresh planner statistics"
    );
  });

  it("does not remove the usable ASC index when replacement verification fails", async () => {
    const client = new FakeIndexClient();
    client.makeCreatedBuildInvalid = true;
    client.states.set(
      HEARTBEAT_HISTORY_INDEX_NAME,
      ascendingState(HEARTBEAT_HISTORY_INDEX_NAME)
    );

    await assert.rejects(
      ensureHeartbeatHistoryIndexOnline(asPoolClient(client)),
      /build index is missing or invalid/
    );

    assert.equal(
      client.states.has(HEARTBEAT_HISTORY_INDEX_NAME),
      true,
      "the verified replacement must precede removal of the legacy index"
    );
    assert.equal(
      client.statements.some(
        (statement) =>
          statement.startsWith("DROP INDEX CONCURRENTLY") &&
          statement.endsWith(HEARTBEAT_HISTORY_INDEX_NAME)
      ),
      false
    );
  });

  it("is idempotent when the canonical index is already exact", async () => {
    const client = new FakeIndexClient();
    client.states.set(
      HEARTBEAT_HISTORY_INDEX_NAME,
      exactState(HEARTBEAT_HISTORY_INDEX_NAME)
    );

    await ensureHeartbeatHistoryIndexOnline(asPoolClient(client));

    assert.equal(
      client.statements.some((statement) =>
        /^(?:CREATE|DROP|ALTER) INDEX/.test(statement)
      ),
      false
    );
    assert.ok(
      client.statements.includes("ANALYZE public.heartbeats"),
      "an exact canonical index must retry an interrupted ANALYZE"
    );
    assert.equal(client.statementTimeout, "15s");
  });

  it("resumes an interrupted run from an already verified build index", async () => {
    const client = new FakeIndexClient();
    client.states.set(
      HEARTBEAT_HISTORY_BUILD_INDEX_NAME,
      exactState(HEARTBEAT_HISTORY_BUILD_INDEX_NAME)
    );

    await ensureHeartbeatHistoryIndexOnline(asPoolClient(client));

    assert.equal(
      isExpectedHeartbeatHistoryIndex(
        client.states.get(HEARTBEAT_HISTORY_INDEX_NAME)
      ),
      true
    );
    assert.equal(
      client.statements.some((statement) =>
        statement.startsWith("CREATE INDEX")
      ),
      false,
      "a verified interrupted build must be reused rather than rebuilt"
    );
    assert.equal(
      client.statements.some((statement) => statement.startsWith("ALTER INDEX")),
      true
    );
    assert.equal(client.statementTimeout, "15s");
  });

  it("removes an invalid interrupted build concurrently before retrying", async () => {
    const client = new FakeIndexClient();
    client.states.set(
      HEARTBEAT_HISTORY_INDEX_NAME,
      ascendingState(HEARTBEAT_HISTORY_INDEX_NAME)
    );
    const invalidBuild = exactState(HEARTBEAT_HISTORY_BUILD_INDEX_NAME);
    invalidBuild.indisvalid = false;
    client.states.set(HEARTBEAT_HISTORY_BUILD_INDEX_NAME, invalidBuild);

    await ensureHeartbeatHistoryIndexOnline(asPoolClient(client));

    const dropBuildPosition = client.statements.findIndex(
      (statement) =>
        statement.startsWith("DROP INDEX CONCURRENTLY") &&
        statement.endsWith(HEARTBEAT_HISTORY_BUILD_INDEX_NAME)
    );
    const createPosition = client.statements.findIndex((statement) =>
      statement.startsWith("CREATE INDEX CONCURRENTLY")
    );
    assert.ok(dropBuildPosition >= 0);
    assert.ok(createPosition > dropBuildPosition);
    assert.equal(
      isExpectedHeartbeatHistoryIndex(
        client.states.get(HEARTBEAT_HISTORY_INDEX_NAME)
      ),
      true
    );
    assert.deepEqual(client.statementTimeoutValues, ["8min", "15s"]);
    assert.ok(client.statements.includes("ANALYZE public.heartbeats"));
  });

  it("adds the missing student-scoped index without replacing the existing device index", async () => {
    const client = new FakeIndexClient();
    client.states.set(
      HEARTBEAT_HISTORY_INDEX_NAME,
      exactState(HEARTBEAT_HISTORY_INDEX_NAME)
    );
    client.states.delete(HEARTBEAT_STUDENT_HISTORY_INDEX_NAME);

    await ensureHeartbeatHistoryIndexOnline(asPoolClient(client));

    assert.equal(
      isExpectedHeartbeatHistoryIndex(
        client.states.get(HEARTBEAT_HISTORY_INDEX_NAME)
      ),
      true
    );
    assert.equal(
      isExpectedHeartbeatStudentHistoryIndex(
        client.states.get(HEARTBEAT_STUDENT_HISTORY_INDEX_NAME)
      ),
      true
    );
    assert.ok(
      client.statements.some(
        (statement) =>
          statement.startsWith("CREATE INDEX CONCURRENTLY") &&
          statement.includes(
            "(school_id, device_id, student_id, timestamp DESC)"
          )
      )
    );
    assert.equal(
      client.statements.some(
        (statement) =>
          statement.startsWith("DROP INDEX CONCURRENTLY") &&
          statement.endsWith(HEARTBEAT_HISTORY_INDEX_NAME)
      ),
      false,
      "the existing device-only access path must be preserved"
    );
    assert.equal(
      client.statements.filter(
        (statement) => statement === "ANALYZE public.heartbeats"
      ).length,
      1
    );
  });

  it("converges a fresh database to both exact history indexes", async () => {
    const client = new FakeIndexClient();
    client.states.clear();

    await ensureHeartbeatHistoryIndexOnline(asPoolClient(client));

    assert.equal(
      isExpectedHeartbeatHistoryIndex(
        client.states.get(HEARTBEAT_HISTORY_INDEX_NAME)
      ),
      true
    );
    assert.equal(
      isExpectedHeartbeatStudentHistoryIndex(
        client.states.get(HEARTBEAT_STUDENT_HISTORY_INDEX_NAME)
      ),
      true
    );
    assert.equal(
      client.statements.filter((statement) =>
        statement.startsWith("CREATE INDEX CONCURRENTLY")
      ).length,
      2
    );
    assert.equal(
      client.statements.filter(
        (statement) => statement === "ANALYZE public.heartbeats"
      ).length,
      1
    );
  });

  it("resumes an interrupted student-scoped build without rebuilding it", async () => {
    const client = new FakeIndexClient();
    client.states.set(
      HEARTBEAT_HISTORY_INDEX_NAME,
      exactState(HEARTBEAT_HISTORY_INDEX_NAME)
    );
    client.states.delete(HEARTBEAT_STUDENT_HISTORY_INDEX_NAME);
    client.states.set(
      HEARTBEAT_STUDENT_HISTORY_BUILD_INDEX_NAME,
      studentExactState(HEARTBEAT_STUDENT_HISTORY_BUILD_INDEX_NAME)
    );

    await ensureHeartbeatHistoryIndexOnline(asPoolClient(client));

    assert.equal(
      isExpectedHeartbeatStudentHistoryIndex(
        client.states.get(HEARTBEAT_STUDENT_HISTORY_INDEX_NAME)
      ),
      true
    );
    assert.equal(
      client.statements.some(
        (statement) =>
          statement.startsWith("CREATE INDEX CONCURRENTLY") &&
          statement.includes(HEARTBEAT_STUDENT_HISTORY_BUILD_INDEX_NAME)
      ),
      false
    );
    assert.equal(
      client.statements.some(
        (statement) =>
          statement.startsWith("ALTER INDEX") &&
          statement.includes(HEARTBEAT_STUDENT_HISTORY_BUILD_INDEX_NAME)
      ),
      true
    );
  });

  it("fails closed on wrong-table, constraint-owned, or unique student index names", async () => {
    const unsafeStates: HeartbeatHistoryIndexState[] = [];
    const wrongTable = studentExactState(
      HEARTBEAT_STUDENT_HISTORY_INDEX_NAME
    );
    wrongTable.table_name = "unrelated_table";
    unsafeStates.push(wrongTable);
    const constraintOwned = studentExactState(
      HEARTBEAT_STUDENT_HISTORY_INDEX_NAME
    );
    constraintOwned.is_constraint_owned = true;
    unsafeStates.push(constraintOwned);
    const unique = studentExactState(HEARTBEAT_STUDENT_HISTORY_INDEX_NAME);
    unique.indisunique = true;
    unsafeStates.push(unique);

    for (const unsafeState of unsafeStates) {
      const client = new FakeIndexClient();
      client.states.set(
        HEARTBEAT_HISTORY_INDEX_NAME,
        exactState(HEARTBEAT_HISTORY_INDEX_NAME)
      );
      client.states.set(
        HEARTBEAT_STUDENT_HISTORY_INDEX_NAME,
        unsafeState
      );

      await assert.rejects(
        ensureHeartbeatHistoryIndexOnline(asPoolClient(client)),
        /refusing online replacement/
      );
      assert.equal(
        client.statements.some((statement) =>
          /^(?:CREATE|DROP|ALTER|ANALYZE)\b/.test(statement)
        ),
        false
      );
    }
  });

  it("drops a malformed interrupted student build concurrently before retrying", async () => {
    const client = new FakeIndexClient();
    client.states.set(
      HEARTBEAT_HISTORY_INDEX_NAME,
      exactState(HEARTBEAT_HISTORY_INDEX_NAME)
    );
    client.states.delete(HEARTBEAT_STUDENT_HISTORY_INDEX_NAME);
    const malformedBuild = studentExactState(
      HEARTBEAT_STUDENT_HISTORY_BUILD_INDEX_NAME
    );
    malformedBuild.indisready = false;
    client.states.set(
      HEARTBEAT_STUDENT_HISTORY_BUILD_INDEX_NAME,
      malformedBuild
    );

    await ensureHeartbeatHistoryIndexOnline(asPoolClient(client));

    const dropPosition = client.statements.findIndex(
      (statement) =>
        statement.startsWith("DROP INDEX CONCURRENTLY") &&
        statement.endsWith(HEARTBEAT_STUDENT_HISTORY_BUILD_INDEX_NAME)
    );
    const createPosition = client.statements.findIndex(
      (statement) =>
        statement.startsWith("CREATE INDEX CONCURRENTLY") &&
        statement.includes(HEARTBEAT_STUDENT_HISTORY_BUILD_INDEX_NAME)
    );
    assert.ok(dropPosition >= 0);
    assert.ok(createPosition > dropPosition);
    assert.equal(
      isExpectedHeartbeatStudentHistoryIndex(
        client.states.get(HEARTBEAT_STUDENT_HISTORY_INDEX_NAME)
      ),
      true
    );
  });

  it("propagates a bounded DDL timeout and restores the migration session", async () => {
    const client = new FakeIndexClient();
    client.states.set(
      HEARTBEAT_HISTORY_INDEX_NAME,
      exactState(HEARTBEAT_HISTORY_INDEX_NAME)
    );
    client.states.delete(HEARTBEAT_STUDENT_HISTORY_INDEX_NAME);
    client.failOnStatementPattern = new RegExp(
      `^CREATE INDEX CONCURRENTLY ${HEARTBEAT_STUDENT_HISTORY_BUILD_INDEX_NAME}\\b`
    );

    await assert.rejects(
      ensureHeartbeatHistoryIndexOnline(asPoolClient(client)),
      /statement timeout/
    );

    assert.equal(client.statementTimeout, "15s");
    assert.deepEqual(client.statementTimeoutValues, ["8min", "15s"]);
    assert.equal(
      client.statements.includes("ANALYZE public.heartbeats"),
      false
    );
    assert.equal(
      client.statements.some((statement) =>
        statement.startsWith("SELECT pg_advisory_unlock")
      ),
      true
    );
  });
});
