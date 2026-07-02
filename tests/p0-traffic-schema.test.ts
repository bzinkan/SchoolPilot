import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { usesDeviceScopedApiLimit } from "../src/util/apiRateLimitRoutes.ts";

describe("P0 traffic and schema guards", () => {
  it("classifies only device-scoped JWT endpoints for token-aware global limiting", () => {
    assert.equal(
      usesDeviceScopedApiLimit({
        method: "POST",
        originalUrl: "/api/classpilot/device/heartbeat",
      }),
      true
    );
    assert.equal(
      usesDeviceScopedApiLimit({
        method: "POST",
        originalUrl: "/api/device/screenshot",
      }),
      true
    );
    assert.equal(
      usesDeviceScopedApiLimit({
        method: "POST",
        originalUrl: "/api/classpilot/extension/runtime-error",
      }),
      true
    );
    assert.equal(
      usesDeviceScopedApiLimit({
        method: "POST",
        originalUrl: "/api/classpilot/register-student",
      }),
      false
    );
    assert.equal(
      usesDeviceScopedApiLimit({
        method: "GET",
        originalUrl: "/api/classpilot/device/screenshot/device-1",
      }),
      false
    );
  });

  it("keeps startup group DDL before dependent group startup work", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const groupsDdl = source.indexOf("CREATE TABLE IF NOT EXISTS groups");
    const groupStudentsDdl = source.indexOf("CREATE TABLE IF NOT EXISTS group_students");
    const groupTeachersDdl = source.indexOf("CREATE TABLE IF NOT EXISTS group_teachers");
    const coTeacherSeed = source.indexOf("Seed co-teacher tables from existing teacherId columns");

    assert.ok(groupsDdl > -1, "groups startup DDL should exist");
    assert.ok(groupStudentsDdl > -1, "group_students startup DDL should exist");
    assert.ok(groupTeachersDdl > -1, "group_teachers startup DDL should exist");
    assert.ok(groupsDdl < groupTeachersDdl, "groups should be created before group_teachers");
    assert.ok(groupsDdl < groupStudentsDdl, "groups should be created before group_students");
    assert.ok(groupStudentsDdl < groupTeachersDdl, "group_students should be ready before group_teachers");
    assert.ok(groupStudentsDdl < coTeacherSeed, "group_students should be ready before dependent group startup work");
    assert.match(source, /CREATE INDEX IF NOT EXISTS groups_school_id_idx/);
    assert.match(source, /groups_school_google_course_unique/);
    assert.match(source, /CREATE UNIQUE INDEX IF NOT EXISTS group_students_unique/);
    assert.match(source, /CREATE INDEX IF NOT EXISTS group_students_group_id_idx/);
    assert.match(source, /CREATE INDEX IF NOT EXISTS group_students_student_id_idx/);
  });
});
