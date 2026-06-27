import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildPrivateEvidenceReadiness,
  writePrivateEvidenceReadiness,
} from "../scripts/soc2/private-evidence-readiness.mjs";

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schoolpilot-soc2-readiness-"));
  fs.mkdirSync(path.join(root, "docs", "soc2"), { recursive: true });
  fs.mkdirSync(path.join(root, "SchoolPilot-SOC2-Evidence"), { recursive: true });
  return root;
}

function write(root: string, relativePath: string, contents: string) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, contents);
}

function writeGovernance(root: string) {
  write(
    root,
    "docs/soc2/governance-controls.json",
    `${JSON.stringify({
      schemaVersion: 1,
      evidenceRepository: "SchoolPilot-SOC2-Evidence",
      humanApprovalBoundary: "Automation drafts records, humans approve decisions.",
      controls: [
        {
          id: "SP-SEC-005",
          owner: "Security & Privacy Officer",
          evidence: [
            {
              name: "Vendor DPA confirmation",
              automation: "human_approved",
              privateEvidenceLocation: "SchoolPilot-SOC2-Evidence/vendors/dpas/",
              humanApproverRole: "Founder",
            },
          ],
        },
      ],
    }, null, 2)}\n`,
  );
}

function privateDir(root: string) {
  return path.join(root, "SchoolPilot-SOC2-Evidence");
}

function writeIncidentRecord(root: string, folder: string, evidenceType: string, status: string) {
  write(
    root,
    `SchoolPilot-SOC2-Evidence/incidents/${folder}/soc2-001-${folder}.json`,
    `${JSON.stringify({
      incidentId: "SOC2-001-HISTORICAL-CREDENTIAL-EXPOSURE",
      evidenceType,
      status,
      privateDetails: "PRIVATE_INCIDENT_BODY_SHOULD_NOT_APPEAR",
    }, null, 2)}\n`,
  );
}

describe("SOC 2 private evidence readiness", () => {
  it("detects approved and not-approved private decision records", () => {
    const root = tempRoot();
    writeGovernance(root);
    write(
      root,
      "SchoolPilot-SOC2-Evidence/risk-acceptances/approved.json",
      `${JSON.stringify({
        approvalId: "APPROVAL-RA-SOC2-002-RISK-ACCEPTANCE",
        controlId: "SP-CONF-002",
        decisionType: "risk_acceptance",
        sourceId: "RA-SOC2-002",
        decision: "approved",
        status: "approved",
        decidedAt: "2026-06-26T12:00:00.000Z",
        expiresAt: "2026-09-25",
        rationale: "PRIVATE_RATIONALE_SHOULD_NOT_APPEAR",
      }, null, 2)}\n`,
    );
    write(
      root,
      "SchoolPilot-SOC2-Evidence/deployments/rejected.json",
      `${JSON.stringify({
        approvalId: "APPROVAL-SP-SEC-004-SHADOW-PRODUCTION-DEPLOYMENT",
        controlId: "SP-SEC-004",
        decisionType: "production_deployment_approval",
        sourceId: "shadow-deployment",
        decision: "not_approved",
        status: "not_approved",
        decidedAt: "2026-06-26T13:00:00.000Z",
        rationale: "PRIVATE_RATIONALE_SHOULD_NOT_APPEAR",
      }, null, 2)}\n`,
    );

    const packet = buildPrivateEvidenceReadiness({
      rootDir: root,
      privateEvidenceDir: privateDir(root),
      now: new Date("2026-06-27T00:00:00Z"),
    });
    const decisions = packet.decisions.map((decision) => `${decision.approvalId}:${decision.decision}`);

    assert.equal(packet.qualityGate.status, "pass");
    assert.ok(decisions.includes("APPROVAL-RA-SOC2-002-RISK-ACCEPTANCE:approved"));
    assert.ok(decisions.includes("APPROVAL-SP-SEC-004-SHADOW-PRODUCTION-DEPLOYMENT:not_approved"));
    assert.ok(packet.decisions.every((decision) => decision.relativePath.startsWith("SchoolPilot-SOC2-Evidence/")));
    assert.ok(packet.decisions.every((decision) => decision.sha256));
    assert.doesNotMatch(JSON.stringify(packet), /PRIVATE_RATIONALE_SHOULD_NOT_APPEAR/);
  });

  it("reports missing incident and tenant isolation private evidence prerequisites", () => {
    const root = tempRoot();
    writeGovernance(root);

    const packet = buildPrivateEvidenceReadiness({
      rootDir: root,
      privateEvidenceDir: privateDir(root),
      now: new Date("2026-06-27T00:00:00Z"),
    });

    const incident = packet.evidenceChecks.find(
      (check) => check.approvalId === "APPROVAL-SP-SEC-003-SOC2-001-HISTORICAL-CREDENTIAL-EXPOSURE-INCIDENT-CLOSURE",
    );
    const tenant = packet.evidenceChecks.find(
      (check) => check.approvalId === "APPROVAL-SP-SEC-002-TENANT-ISOLATION-EVIDENCE-REVIEW",
    );

    assert.equal(incident?.status, "missing");
    assert.deepEqual(incident?.missingEvidence, [
      "Credential rotation evidence",
      "Security log review evidence",
      "Exposure assessment evidence",
    ]);
    assert.equal(tenant?.status, "missing");
    assert.deepEqual(tenant?.missingEvidence, [
      "Production RLS status export",
      "DB grants and policies export",
    ]);
  });

  it("marks private evidence checks ready when files exist without copying contents", () => {
    const root = tempRoot();
    writeGovernance(root);
    write(root, "SchoolPilot-SOC2-Evidence/vendors/dpas/vendor.txt", "PRIVATE_CONTRACT_BODY");
    writeIncidentRecord(root, "credential-rotation", "credential_rotation", "ready_for_approval");
    writeIncidentRecord(root, "log-review", "log_review", "ready_for_approval");
    writeIncidentRecord(root, "exposure-assessment", "exposure_assessment", "ready_for_approval");
    write(root, "SchoolPilot-SOC2-Evidence/tenant-isolation/production-rls-export/rls.json", "PRIVATE_RLS_BODY");
    write(root, "SchoolPilot-SOC2-Evidence/tenant-isolation/db-grants-policies-export/grants.sql", "PRIVATE_GRANTS_BODY");

    const packet = buildPrivateEvidenceReadiness({
      rootDir: root,
      privateEvidenceDir: privateDir(root),
      now: new Date("2026-06-27T00:00:00Z"),
    });
    const vendor = packet.evidenceChecks.find(
      (check) => check.approvalId === "APPROVAL-SP-SEC-005-VENDOR-DPA-CONFIRMATION",
    );
    const incident = packet.evidenceChecks.find(
      (check) => check.approvalId === "APPROVAL-SP-SEC-003-SOC2-001-HISTORICAL-CREDENTIAL-EXPOSURE-NOTIFICATION-DECISION",
    );
    const tenant = packet.evidenceChecks.find(
      (check) => check.approvalId === "APPROVAL-SP-SEC-002-TENANT-ISOLATION-EVIDENCE-REVIEW",
    );
    const serialized = JSON.stringify(packet);

    assert.equal(vendor?.status, "ready");
    assert.equal(incident?.status, "ready");
    assert.equal(tenant?.status, "ready");
    assert.match(serialized, /SchoolPilot-SOC2-Evidence\/vendors\/dpas\/vendor.txt/);
    assert.match(serialized, /sha256/);
    assert.doesNotMatch(serialized, /PRIVATE_CONTRACT_BODY/);
    assert.doesNotMatch(serialized, /PRIVATE_INCIDENT_BODY_SHOULD_NOT_APPEAR/);
    assert.doesNotMatch(serialized, /PRIVATE_RLS_BODY/);
  });

  it("does not treat .gitkeep or draft SOC2-001 files as ready", () => {
    const root = tempRoot();
    writeGovernance(root);
    write(root, "SchoolPilot-SOC2-Evidence/incidents/credential-rotation/.gitkeep", "");
    write(root, "SchoolPilot-SOC2-Evidence/incidents/log-review/.gitkeep", "");
    write(root, "SchoolPilot-SOC2-Evidence/incidents/exposure-assessment/.gitkeep", "");
    writeIncidentRecord(root, "credential-rotation", "credential_rotation", "draft_pending_founder_input");
    writeIncidentRecord(root, "log-review", "log_review", "draft_pending_founder_input");
    writeIncidentRecord(root, "exposure-assessment", "exposure_assessment", "draft_pending_founder_input");

    const packet = buildPrivateEvidenceReadiness({
      rootDir: root,
      privateEvidenceDir: privateDir(root),
      now: new Date("2026-06-27T00:00:00Z"),
    });
    const incident = packet.evidenceChecks.find(
      (check) => check.approvalId === "APPROVAL-SP-SEC-003-SOC2-001-HISTORICAL-CREDENTIAL-EXPOSURE-INCIDENT-CLOSURE",
    );

    assert.equal(incident?.status, "missing");
    assert.deepEqual(incident?.missingEvidence, [
      "Credential rotation evidence",
      "Security log review evidence",
      "Exposure assessment evidence",
    ]);
    assert.ok(incident?.requiredEvidence.every((item) => item.readyFileCount === 0));
    assert.ok(incident?.requiredEvidence.every((item) => item.readinessStatus === "draft_pending_founder_input"));
  });

  it("writes JSON and Markdown readiness packets", () => {
    const root = tempRoot();
    writeGovernance(root);
    const packet = buildPrivateEvidenceReadiness({
      rootDir: root,
      privateEvidenceDir: privateDir(root),
      now: new Date("2026-06-27T00:00:00Z"),
    });
    const { jsonPath, mdPath } = writePrivateEvidenceReadiness(
      packet,
      path.join(root, "soc2-evidence", "private-readiness"),
    );

    assert.ok(fs.existsSync(jsonPath));
    assert.ok(fs.existsSync(mdPath));
    assert.match(fs.readFileSync(mdPath, "utf8"), /non-sensitive metadata only/);
  });
});
