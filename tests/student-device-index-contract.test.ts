import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("student-device teacher-tile index contract", () => {
  let importedPool: (Awaited<typeof import("../dist/db.js")>)["pool"] | undefined;

  after(async () => {
    await importedPool?.end();
  });

  it("defines the device-leading composite index in the Drizzle schema", () => {
    const schemaSource = readFileSync(
      new URL("../src/schema/classpilot.ts", import.meta.url),
      "utf8"
    );
    const tableStart = schemaSource.indexOf("export const studentDevices");
    const tableEnd = schemaSource.indexOf(
      "export type StudentDevice",
      tableStart
    );
    assert.ok(tableStart >= 0 && tableEnd > tableStart);
    const tableSource = schemaSource.slice(tableStart, tableEnd);

    assert.match(
      tableSource,
      /index\("student_devices_device_student_idx"\)\.on\(table\.deviceId,\s*table\.studentId\)/
    );
    assert.match(
      tableSource,
      /unique\("student_devices_unique"\)\.on\(table\.studentId,\s*table\.deviceId\)/
    );
  });

  it("builds online, repairs invalid artifacts, verifies validity, and fails closed", () => {
    const migrationSource = readFileSync(
      new URL("../src/index.ts", import.meta.url),
      "utf8"
    );
    const migrationStart = migrationSource.indexOf(
      "const studentDeviceIndexLock"
    );
    const migrationEnd = migrationSource.indexOf(
      "// Backfill emailLc",
      migrationStart
    );
    assert.ok(migrationStart >= 0 && migrationEnd > migrationStart);
    const migration = migrationSource.slice(migrationStart, migrationEnd);

    assert.match(migration, /pg_advisory_lock\(hashtext\(\$1\)\)/);
    assert.match(
      migration,
      /DROP INDEX CONCURRENTLY IF EXISTS student_devices_device_student_idx/
    );
    assert.match(
      migration,
      /CREATE INDEX CONCURRENTLY IF NOT EXISTS student_devices_device_student_idx ON student_devices \(device_id, student_id\)/
    );
    assert.match(migration, /i\.indisvalid/);
    assert.match(migration, /i\.indisready/);
    assert.match(migration, /table_class\.relname AS table_name/);
    assert.match(migration, /unnest\(i\.indkey::smallint\[\]\)/);
    assert.match(migration, /attribute\.attname/);
    assert.match(migration, /attribute\.attname::text/);
    assert.match(migration, /access_method\.amname AS access_method/);
    assert.match(migration, /state\.table_name === "student_devices"/);
    assert.match(migration, /state\.key_columns\[0\] === "device_id"/);
    assert.match(migration, /state\.key_columns\[1\] === "student_id"/);
    assert.match(
      migration,
      /!isExpectedStudentDeviceIndex\(verified\.rows\[0\]\)/
    );
    assert.match(migration, /throw new Error\([^)]*missing or invalid/i);
    assert.match(migration, /catch \(err\)[\s\S]*throw err/);
    assert.match(migration, /pg_advisory_unlock\(hashtext\(\$1\)\)/);

    assert.doesNotMatch(
      migration,
      /CREATE INDEX IF NOT EXISTS student_devices_device_student_idx/,
      "the production migration must never fall back to a blocking index build"
    );
    assert.doesNotMatch(migration, /index skipped/i);
  });

  it("parses inspected index key columns as a text array", {
    skip: !process.env.DATABASE_URL,
  }, async () => {
    const database = await import("../dist/db.js");
    importedPool = database.pool;
    const client = await database.pool.connect();
    try {
      await client.query(`
        CREATE TEMP TABLE student_devices_index_contract_fixture (
          device_id text NOT NULL,
          student_id uuid NOT NULL
        )
      `);
      await client.query(`
        CREATE INDEX student_devices_index_contract_fixture_idx
        ON student_devices_index_contract_fixture (device_id, student_id)
      `);
      const result = await client.query<{ key_columns: string[] }>(`
        SELECT ARRAY(
          SELECT attribute.attname::text
          FROM pg_class AS idx
          INNER JOIN pg_index AS i ON i.indexrelid = idx.oid
          INNER JOIN pg_attribute AS attribute
            ON attribute.attrelid = i.indrelid
           AND attribute.attnum = ANY(i.indkey)
          WHERE idx.relname = 'student_devices_index_contract_fixture_idx'
          ORDER BY array_position(i.indkey::smallint[], attribute.attnum)
        ) AS key_columns
      `);
      assert.ok(Array.isArray(result.rows[0]?.key_columns));
      assert.deepEqual(result.rows[0]?.key_columns, ["device_id", "student_id"]);
    } finally {
      client.release();
    }
  });
});
