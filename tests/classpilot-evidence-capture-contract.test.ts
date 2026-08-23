import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  CLASSPILOT_27_EVIDENCE_AUTHORITY_SQL,
  CLASSPILOT_27_SAFETY_CAPTURE_SQL,
  schoolPilot27Migrations,
} from "../src/db/migrations27.js";
import {
  assertClasspilotScreenshotEvidenceAuthority,
  classpilotEvidenceUrlDigest,
} from "../src/services/classpilotEvidenceAuthority.js";

describe("ClassPilot exact safety capture persistence contract", () => {
  it("uses a separate checksum-ledger migration and tenant composite student FK", () => {
    assert.equal(
      schoolPilot27Migrations.some((migration) =>
        migration.id === "20260822_classpilot_safety_capture_expand"
      ),
      true
    );
    assert.match(CLASSPILOT_27_SAFETY_CAPTURE_SQL, /school_id TEXT NOT NULL/);
    assert.match(
      CLASSPILOT_27_SAFETY_CAPTURE_SQL,
      /FOREIGN KEY \(school_id, student_id\)[\s\S]*REFERENCES students \(school_id, id\)/
    );
    assert.match(CLASSPILOT_27_SAFETY_CAPTURE_SQL, /tab_snapshot_revision INTEGER NOT NULL/);
    assert.match(
      CLASSPILOT_27_SAFETY_CAPTURE_SQL,
      /ALTER TABLE classpilot_evidence_capture_requests ENABLE ROW LEVEL SECURITY/
    );
    assert.match(
      CLASSPILOT_27_SAFETY_CAPTURE_SQL,
      /ALTER TABLE classpilot_evidence_capture_requests FORCE ROW LEVEL SECURITY/
    );
    assert.match(
      CLASSPILOT_27_SAFETY_CAPTURE_SQL,
      /CREATE POLICY tenant_isolation[\s\S]*current_setting\('app\.school_id', true\)[\s\S]*WITH CHECK/
    );
  });

  it("never persists a raw expected URL in the request authority field", () => {
    const url = "https://example.test/private?q=student-secret";
    const digest = classpilotEvidenceUrlDigest(url);
    assert.equal(digest.length, 64);
    assert.equal(digest.includes("student-secret"), false);
    assert.notEqual(digest, classpilotEvidenceUrlDigest(`${url}-different`));
  });

  it("expands screenshot artifacts with internal device authority and enforces new exact rows", () => {
    assert.equal(
      schoolPilot27Migrations.some((migration) =>
        migration.id === "20260822_classpilot_evidence_authority_expand"
      ),
      true
    );
    assert.match(CLASSPILOT_27_EVIDENCE_AUTHORITY_SQL, /ADD COLUMN IF NOT EXISTS device_id TEXT/);
    assert.match(CLASSPILOT_27_EVIDENCE_AUTHORITY_SQL, /ADD COLUMN IF NOT EXISTS student_session_id VARCHAR/);
    assert.match(CLASSPILOT_27_EVIDENCE_AUTHORITY_SQL, /ADD COLUMN IF NOT EXISTS binding_version TEXT/);
    assert.match(
      CLASSPILOT_27_EVIDENCE_AUTHORITY_SQL,
      /evidence_artifacts_screenshot_exact_authority_check[\s\S]*device_id IS NOT NULL[\s\S]*student_session_id IS NOT NULL[\s\S]*binding_version IS NOT NULL[\s\S]*NOT VALID/
    );
    assert.match(CLASSPILOT_27_EVIDENCE_AUTHORITY_SQL, /evidence_artifacts_exact_authority_idx/);

    const exact = {
      artifactType: "screenshot",
      schoolId: "school",
      deviceId: "device",
      studentId: "student",
      studentSessionId: "student-session",
      bindingVersion: "v1:binding",
      capturedAt: new Date("2026-08-22T12:00:00.000Z"),
    };
    assert.doesNotThrow(() => assertClasspilotScreenshotEvidenceAuthority(exact));
    assert.throws(
      () => assertClasspilotScreenshotEvidenceAuthority({ ...exact, deviceId: null }),
      /CLASSPILOT_EVIDENCE_AUTHORITY_REQUIRED/
    );
    assert.throws(
      () => assertClasspilotScreenshotEvidenceAuthority({ ...exact, studentSessionId: "" }),
      /CLASSPILOT_EVIDENCE_AUTHORITY_REQUIRED/
    );
    assert.doesNotThrow(() => assertClasspilotScreenshotEvidenceAuthority({
      ...exact,
      artifactType: "zip_manifest",
      deviceId: null,
      studentSessionId: null,
      bindingVersion: null,
      capturedAt: null,
    }));
  });

  it("persists the complete tuple for ambient, uploaded, failed, and expired screenshot artifacts", () => {
    const devicesRoute = readFileSync(
      new URL("../src/routes/classpilot/devices.ts", import.meta.url),
      "utf8"
    );
    const captureService = readFileSync(
      new URL("../src/services/classpilotEvidenceCapture.ts", import.meta.url),
      "utf8"
    );
    const scheduler = readFileSync(
      new URL("../src/services/scheduler.ts", import.meta.url),
      "utf8"
    );
    const expiryStart = scheduler.indexOf(
      "export async function expireClasspilotEvidenceCaptureRequests"
    );
    const expiryEnd = scheduler.indexOf("// Import-run history retention", expiryStart);
    assert.notEqual(expiryStart, -1);
    assert.notEqual(expiryEnd, -1);
    const expiryJob = scheduler.slice(expiryStart, expiryEnd);
    const ambientWriteStart = devicesRoute.indexOf("await createEvidenceArtifact({");
    assert.notEqual(ambientWriteStart, -1);
    const ambientWrite = devicesRoute.slice(ambientWriteStart, ambientWriteStart + 1_500);
    for (const authorityField of [
      /schoolId,/,
      /deviceId,/,
      /studentId,/,
      /studentSessionId,/,
      /bindingVersion:/,
      /capturedAt:/,
    ]) {
      assert.match(ambientWrite, authorityField);
    }
    assert.match(captureService, /exactScreenshotArtifactAuthority\(input, now\)/);
    assert.match(captureService, /exactScreenshotArtifactAuthority\(input, input\.capturedAt\)/);
    assert.match(
      expiryJob,
      /INSERT INTO evidence_artifacts \([\s\S]{0,200}school_id, device_id, student_id, student_session_id, binding_version[\s\S]{0,300}due\.school_id,[\s\S]{0,50}due\.device_id,[\s\S]{0,50}due\.student_id,[\s\S]{0,50}due\.student_session_id/
    );
    assert.match(expiryJob, /encode\(sha256\([\s\S]*convert_to\(due\.school_id, 'UTF8'\)/);
    assert.match(expiryJob, /decode\('00', 'hex'\)/);
    assert.doesNotMatch(expiryJob, /\bdigest\(/);
    assert.doesNotMatch(expiryJob, /chr\(0\)/);
  });

  it("is included in the production RLS allowlist and fail-closed review registry", () => {
    const production = readFileSync(new URL("../infra/production.tfvars", import.meta.url), "utf8");
    const startup = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const registry = readFileSync(
      new URL("../src/config/rlsRegistry.json", import.meta.url),
      "utf8",
    );
    assert.match(production, /classpilot_evidence_capture_requests/);
    assert.match(
      registry,
      /"classpilotEvidenceCapture"[\s\S]*?"classpilot_evidence_capture_requests"/,
    );
    assert.match(startup, /isReviewedRlsEnforcementRequest\(requiredRlsTables\)/);
  });
});
