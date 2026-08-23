import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.SCHEDULER_ENABLED = "true";

const { pool } = await import("../dist/db.js");
const {
  schedulerLockPool,
  schedulerPool,
} = await import("../dist/services/schedulerDb.js");
const {
  expireClasspilotEvidenceCaptureRequests,
} = await import("../dist/services/scheduler.js");
const {
  screenshotBindingVersion,
} = await import("../dist/realtime/ws-redis.js");
const { default: errorMonitor } = await import("../dist/services/errorMonitor.js");

const schoolId = randomUUID();
const studentId = randomUUID();
const requestId = randomUUID();
const binding = {
  schoolId,
  deviceId: `device-π-${randomUUID()}`,
  studentId,
  studentSessionId: `session-雪-${randomUUID()}`,
};

describe("ClassPilot expired safety evidence binding digest", () => {
  before(async () => {
    await schedulerPool.query(
      `INSERT INTO schools (id, name, domain, slug)
       VALUES ($1, $2, $3, $4)`,
      [schoolId, "Evidence expiry digest test", `${schoolId}.example.test`, `evidence-${schoolId}`]
    );
    await schedulerPool.query(
      `INSERT INTO students (id, school_id, first_name, last_name)
       VALUES ($1, $2, $3, $4)`,
      [studentId, schoolId, "Evidence", "Digest"]
    );
    await schedulerPool.query(
      `INSERT INTO classpilot_evidence_capture_requests (
         id, school_id, student_id, student_session_id, device_id,
         heartbeat_id, tab_ref, tab_snapshot_revision, expected_url_digest,
         status, requested_at, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9,
         'pending', now() - interval '2 minutes', now() - interval '1 minute'
       )`,
      [
        requestId,
        binding.schoolId,
        binding.studentId,
        binding.studentSessionId,
        binding.deviceId,
        randomUUID(),
        "tab:test",
        1,
        "0".repeat(64),
      ]
    );
  });

  after(async () => {
    await schedulerPool.query(
      "DELETE FROM evidence_artifacts WHERE school_id = $1 AND source_id = $2",
      [schoolId, requestId]
    );
    await schedulerPool.query(
      "DELETE FROM classpilot_evidence_capture_requests WHERE school_id = $1 AND id = $2",
      [schoolId, requestId]
    );
    await schedulerPool.query(
      "DELETE FROM students WHERE school_id = $1 AND id = $2",
      [schoolId, studentId]
    );
    await schedulerPool.query("DELETE FROM schools WHERE id = $1", [schoolId]);
    errorMonitor.dispose();
    await Promise.allSettled([
      pool.end(),
      schedulerPool.end(),
      schedulerLockPool.end(),
    ]);
  });

  it("creates one exact-bound unavailable artifact without pgcrypto", async () => {
    await expireClasspilotEvidenceCaptureRequests();
    await expireClasspilotEvidenceCaptureRequests();

    const request = await schedulerPool.query<{
      status: string;
      artifact_id: string | null;
      completed_at: Date | null;
    }>(
      `SELECT status, artifact_id, completed_at
       FROM classpilot_evidence_capture_requests
       WHERE school_id = $1 AND id = $2`,
      [schoolId, requestId]
    );
    const requestRow = request.rows[0];
    assert.ok(requestRow);
    assert.equal(requestRow.status, "expired");
    assert.ok(requestRow.artifact_id);
    assert.ok(requestRow.completed_at instanceof Date);

    const artifact = await schedulerPool.query<{
      id: string;
      school_id: string;
      student_id: string;
      device_id: string;
      student_session_id: string;
      binding_version: string;
      source_type: string;
      source_id: string;
      artifact_type: string;
      status: string;
      content: string | null;
      unavailable_reason: string | null;
    }>(
      `SELECT
         id, school_id, student_id, device_id, student_session_id, binding_version,
         source_type, source_id, artifact_type, status, content,
         metadata->>'unavailableReason' AS unavailable_reason
       FROM evidence_artifacts
       WHERE school_id = $1 AND source_id = $2`,
      [schoolId, requestId]
    );

    assert.equal(artifact.rowCount, 1);
    const artifactRow = artifact.rows[0];
    assert.ok(artifactRow);
    assert.equal(requestRow.artifact_id, artifactRow.id);
    const { id: artifactId, ...artifactAuthority } = artifactRow;
    assert.match(artifactId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(artifactAuthority, {
      school_id: binding.schoolId,
      student_id: binding.studentId,
      device_id: binding.deviceId,
      student_session_id: binding.studentSessionId,
      binding_version: screenshotBindingVersion(binding),
      source_type: "classpilot_safety_capture",
      source_id: requestId,
      artifact_type: "screenshot",
      status: "unavailable",
      content: null,
      unavailable_reason: "expired",
    });
  });
});
