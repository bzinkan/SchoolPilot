import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildMonitoringEvidence,
  validateMonitoringEvidence,
  writeMonitoringEvidence,
} from "../scripts/soc2/collect-monitoring-evidence.mjs";

function write(root: string, relativePath: string, contents: string) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, contents);
}

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schoolpilot-soc2-monitoring-"));
  write(root, "src/services/monitoringDashboard.ts", "SELECT 1 pool.waitingCount sanitizeRecentErrorLogForMonitoring");
  write(root, "src/services/errorMonitor.ts", "getAlertingStatus sanitizeMonitorString TOKEN_VALUE_SHOULD_NOT_APPEAR");
  write(root, "src/services/securityMonitor.ts", "checkFailedAuthSpike checkBulkStudentOps checkOffHoursAdminBurst checkCrossSchoolAccess");
  write(root, "src/routes/admin/monitoring.ts", "Super admin access required");
  write(root, "src/routes/admin/soc2.ts", "Super admin access required");
  write(root, "src/services/soc2Dashboard.ts", "unavailable partial dashboard");
  write(root, "src/schema/shared.ts", "auditLogs securityEvents errorLogs");
  write(root, "tests/error-monitor.test.ts", "monitoring dashboard tests");
  write(root, "tests/soc2-dashboard-service.test.ts", "soc2 dashboard tests");
  write(root, ".github/workflows/ci-build.yml", "name: CI");
  write(root, ".github/workflows/codeql.yml", "name: CodeQL");
  write(root, ".github/workflows/gitleaks.yml", "name: Gitleaks");
  write(root, ".github/workflows/trivy.yml", "name: Trivy");
  return root;
}

function githubEnv(overrides: Record<string, string> = {}) {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "bzinkan/SchoolPilot",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_WORKFLOW: "CI",
    GITHUB_RUN_ID: "123456",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_JOB: "soc2-monitoring-evidence",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REF_NAME: "main",
    GITHUB_SHA: "abc123",
    GITHUB_ACTOR: "bzinkan",
    GITHUB_EVENT_NAME: "push",
    JOB_STATUS: "success",
    APP_HEALTH_URL: "https://school-pilot.net/health",
    APP_HEALTH_STATUS: "healthy",
    CI_JOB_RESULTS: JSON.stringify({
      backend: { result: "success" },
      frontend: { result: "success" },
    }),
    ...overrides,
  };
}

describe("SOC 2 monitoring evidence", () => {
  it("creates JSON and Markdown monitoring packets", () => {
    const root = tempRoot();
    const evidence = buildMonitoringEvidence({
      rootDir: root,
      env: githubEnv(),
      now: new Date("2026-06-28T12:00:00Z"),
    });
    const { jsonPath, mdPath } = writeMonitoringEvidence(evidence, path.join(root, "soc2-evidence", "monitoring"));

    assert.equal(evidence.validation.status, "pass");
    assert.match(jsonPath, /soc2-monthly-monitoring-evidence\.json$/);
    assert.ok(fs.existsSync(jsonPath));
    assert.ok(fs.existsSync(mdPath));
    assert.match(fs.readFileSync(mdPath, "utf8"), /SOC 2 Monthly Monitoring Evidence/);
  });

  it("includes commit, workflow, run, health, and scan metadata", () => {
    const root = tempRoot();
    const { packet } = buildMonitoringEvidence({
      rootDir: root,
      env: githubEnv(),
      now: new Date("2026-06-28T12:00:00Z"),
    });

    assert.equal(packet.git.repository, "bzinkan/SchoolPilot");
    assert.equal(packet.git.ref, "refs/heads/main");
    assert.equal(packet.git.branch, "main");
    assert.equal(packet.git.commitSha, "abc123");
    assert.equal(packet.ci.runUrl, "https://github.com/bzinkan/SchoolPilot/actions/runs/123456");
    assert.equal(packet.healthEvidence.status, "healthy");
    assert.ok(packet.scanEvidencePointers.some((item) => item.scanType === "code_scanning"));
    assert.ok(packet.ci.jobResults.some((item) => item.job === "backend" && item.result === "success"));
  });

  it("records source hashes, safeguards, and private pointers without secrets", () => {
    const root = tempRoot();
    const { packet } = buildMonitoringEvidence({
      rootDir: root,
      env: githubEnv(),
      now: new Date("2026-06-28T12:00:00Z"),
    });
    const serialized = JSON.stringify(packet);

    assert.match(packet.sourceHashes.monitoringDashboard.sha256 || "", /^[a-f0-9]{64}$/);
    assert.equal(packet.monitoringSafeguards.postgresHealthProbe, "present");
    assert.ok(packet.securityEventCoverage.some((item) => item.eventType === "cross_school_access"));
    assert.equal(packet.privateEvidencePointers.monthlyAlertReview, "SchoolPilot-SOC2-Evidence/security-events/reviews/soc2-monthly-alert-review.json");
    assert.doesNotMatch(serialized, /TOKEN_VALUE_SHOULD_NOT_APPEAR/);
    assert.doesNotMatch(serialized, /PRIVATE_LOG_BODY/);
    assert.doesNotMatch(serialized, /PRIVATE_STUDENT_DATA/);
  });

  it("preserves no-user-facing app impact and pending human reviews", () => {
    const root = tempRoot();
    const { packet } = buildMonitoringEvidence({
      rootDir: root,
      env: githubEnv(),
      now: new Date("2026-06-28T12:00:00Z"),
    });

    assert.equal(packet.appImpact, "No user-facing behavior changed");
    assert.deepEqual(packet.controls, ["SP-AVL-002", "SP-SEC-003"]);
    assert.ok(packet.humanReviews.every((review) => review.status === "pending_human_approval"));
    assert.ok(packet.humanReviews.some((review) => review.approvalId === "APPROVAL-SP-AVL-002-MONTHLY-MONITORING-REVIEW"));
    assert.ok(packet.humanReviews.some((review) => review.approvalId === "APPROVAL-SP-SEC-003-MONTHLY-ALERT-REVIEW-DECISION"));
  });

  it("fails validation when required fields are missing", () => {
    const root = tempRoot();
    const { packet } = buildMonitoringEvidence({
      rootDir: root,
      env: githubEnv(),
      now: new Date("2026-06-28T12:00:00Z"),
    });
    const broken = structuredClone(packet);
    broken.git.commitSha = "";
    broken.healthEvidence.status = "";
    broken.humanReviews[0].status = "approved";

    const validation = validateMonitoringEvidence(broken);

    assert.equal(validation.status, "fail");
    assert.match(validation.errors.join("\n"), /git\.commitSha/);
    assert.match(validation.errors.join("\n"), /healthEvidence\.status/);
    assert.match(validation.errors.join("\n"), /pending human approval/);
  });
});
