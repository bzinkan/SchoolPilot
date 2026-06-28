import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildApprovalQueue,
  recordApprovalDecision,
  writeApprovalQueue,
} from "../scripts/soc2/approval-queue.mjs";
import {
  buildPrivateEvidenceReadiness,
  writePrivateEvidenceReadiness,
} from "../scripts/soc2/private-evidence-readiness.mjs";

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schoolpilot-soc2-approval-"));
  fs.mkdirSync(path.join(root, "docs", "soc2"), { recursive: true });
  return root;
}

function write(root: string, relativePath: string, contents: string) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, contents);
}

function humanEvidence(name: string, privateEvidenceLocation: string, humanApproverRole = "Founder") {
  return {
    name,
    automation: "human_approved",
    privateEvidenceLocation,
    humanApproverRole,
  };
}

function control(id: string, evidence: unknown[]) {
  return {
    id,
    owner: id.startsWith("SP-AVL") ? "Engineering" : "Security & Privacy Officer",
    status: "Implementing",
    frequency: "Continuous",
    nextReviewDue: "2026-09-30",
    automationImpact: "No user-facing workflow changes.",
    evidence,
  };
}

function writeSoc2Docs(root: string) {
  const governance = {
    schemaVersion: 1,
    evidenceRepository: "SchoolPilot-SOC2-Evidence",
    humanApprovalBoundary: "Automation drafts records, but humans approve or reject decisions.",
    controls: [
      control("SP-SEC-001", [
        humanEvidence("Quarterly privileged access review packet", "SchoolPilot-SOC2-Evidence/access-reviews/"),
        humanEvidence("Privileged MFA rollout decision", "SchoolPilot-SOC2-Evidence/risk-acceptances/"),
      ]),
      control("SP-SEC-003", [
        humanEvidence("Monthly alert review decision", "SchoolPilot-SOC2-Evidence/security-events/reviews/"),
        humanEvidence("Incident decision record", "SchoolPilot-SOC2-Evidence/incidents/"),
        humanEvidence("Founder-only security training attestation", "SchoolPilot-SOC2-Evidence/training/"),
      ]),
      control("SP-SEC-004", [
        humanEvidence("Production deployment approval", "SchoolPilot-SOC2-Evidence/deployments/"),
      ]),
      control("SP-SEC-005", [
        humanEvidence("Vendor DPA confirmation", "SchoolPilot-SOC2-Evidence/vendors/dpas/"),
        humanEvidence("Annual vendor review packet", "SchoolPilot-SOC2-Evidence/vendors/reviews/"),
      ]),
      control("SP-AVL-001", [
        humanEvidence("Restore drill approval", "SchoolPilot-SOC2-Evidence/backups/restore-tests/"),
      ]),
      control("SP-AVL-002", [
        { name: "Health monitor sample", automation: "automated", privateEvidenceLocation: "SchoolPilot-SOC2-Evidence/monitoring/" },
        humanEvidence("Monthly monitoring review", "SchoolPilot-SOC2-Evidence/monitoring/reviews/", "Engineering Lead"),
      ]),
      control("SP-CONF-002", [
        humanEvidence("AI data-flow review", "SchoolPilot-SOC2-Evidence/ai/reviews/"),
      ]),
    ],
  };

  const riskPolicy = {
    schemaVersion: 1,
    owner: "Founder / Security & Privacy Officer",
    approverRole: "Founder",
    privateEvidenceLocation: "SchoolPilot-SOC2-Evidence/risk-acceptances/",
    draftStatus: "Draft - pending founder approval",
    defaultExpirationDays: 90,
    autoDraftPriorities: ["P0", "P1"],
    autoDraftStatuses: ["Open", "In progress"],
    riskLevelByPriority: {
      P0: "High",
      P1: "Medium",
      P2: "Low",
    },
    compensatingControlsByArea: {
      "Incident response": ["Track credential rotation evidence"],
      "Privileged access": ["Perform manual privileged access review"],
    },
  };

  write(root, "docs/soc2/governance-controls.json", `${JSON.stringify(governance, null, 2)}\n`);
  write(root, "docs/soc2/risk-acceptance-policy.json", `${JSON.stringify(riskPolicy, null, 2)}\n`);
  write(
    root,
    "docs/soc2/remediation-register.md",
    `# Remediation

| ID | Priority | Area | Gap | Owner | Target | Evidence Needed | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SOC2-001 | P0 | Incident response | Historical credential exposure needs record. | Security | Before observation | Incident report | Open |
| SOC2-003 | P1 | Privileged access | MFA deferred. | Engineering | Before observation | Risk acceptance | In progress |
| SOC2-009 | P2 | Mobile | Storage hardening. | Engineering | Before observation | Build config | Open |
`,
  );
}

function writeDeploymentEvidence(root: string) {
  write(
    root,
    "soc2-evidence/deployments/2026-06-26-shadow-deployment-evidence.json",
    `${JSON.stringify({
      evidenceId: "2026-06-26-shadow-deployment-evidence",
      ci: { runUrl: "https://github.com/bzinkan/SchoolPilot/actions/runs/123" },
      deployment: { productionApproverRole: "Founder / Engineering owner" },
    }, null, 2)}\n`,
  );
  write(root, "soc2-evidence/deployments/2026-06-26-shadow-deployment-evidence.md", "# Deployment evidence\n");
}

function writeNotRequestedDeploymentEvidence(root: string) {
  write(
    root,
    "soc2-evidence/deployments/2026-06-27-shadow-deployment-evidence.json",
    `${JSON.stringify({
      evidenceId: "2026-06-27-shadow-deployment-evidence",
      ci: { runUrl: "https://github.com/bzinkan/SchoolPilot/actions/runs/456" },
      deployment: {
        productionDeployDecision: "not_requested",
        productionApprovalStatus: "pending_human_approval",
        imageDigest: "pending/not_deployed",
        deploymentResult: "not_deployed",
      },
    }, null, 2)}\n`,
  );
  write(root, "soc2-evidence/deployments/2026-06-27-shadow-deployment-evidence.md", "# Deployment evidence\n");
}

function writeIncidentEvidence(root: string) {
  write(
    root,
    "soc2-evidence/incidents/soc2-001-historical-credential-exposure-incident-evidence.json",
    `${JSON.stringify({
      evidenceId: "SOC2-001-HISTORICAL-CREDENTIAL-EXPOSURE",
      controls: ["SP-SEC-003"],
      remediationItems: ["SOC2-001"],
      appImpact: "No user-facing behavior changed",
      incident: {
        incidentId: "SOC2-001-HISTORICAL-CREDENTIAL-EXPOSURE",
        privateEvidenceLocation: "SchoolPilot-SOC2-Evidence/incidents/",
      },
      evidencePointers: {
        credentialRotation: [
          {
            label: "Credential rotation evidence",
            location: "SchoolPilot-SOC2-Evidence/incidents/credential-rotation/",
          },
        ],
        logReview: [
          {
            label: "Security log review evidence",
            location: "SchoolPilot-SOC2-Evidence/incidents/log-review/",
          },
        ],
      },
      exposureAssessment: {
        evidencePointer: "SchoolPilot-SOC2-Evidence/incidents/exposure-assessment/",
      },
      humanDecisions: {
        closure: {
          decisionType: "incident_decision",
          status: "pending_human_approval",
          approverRole: "Security & Privacy Officer",
        },
        notification: {
          decisionType: "notification_decision",
          status: "pending_human_approval",
          approverRole: "Security & Privacy Officer",
        },
      },
    }, null, 2)}\n`,
  );
  write(root, "soc2-evidence/incidents/soc2-001-historical-credential-exposure-incident-evidence.md", "# Incident evidence\n");
}

function writeTenantIsolationEvidence(root: string) {
  write(
    root,
    "soc2-evidence/tenant-isolation/tenant-isolation-evidence.json",
    `${JSON.stringify({
      evidenceId: "TENANT-ISOLATION-EVIDENCE",
      controls: ["SP-SEC-002"],
      remediationItems: ["SOC2-005"],
      appImpact: "No user-facing behavior changed",
      ci: {
        evidenceArtifacts: {
          crossTenantTests: "soc2-evidence-cross-tenant",
          rlsEnabledTests: "soc2-evidence-rls-enabled",
        },
      },
      rls: {
        productionStatusExport: "pending_private_export",
        dbGrantsAndPoliciesExport: "pending_private_export",
        privateEvidenceLocation: "SchoolPilot-SOC2-Evidence/tenant-isolation/",
      },
      humanReview: {
        decisionType: "tenant_isolation_review",
        status: "pending_human_approval",
        approverRole: "Engineering",
      },
    }, null, 2)}\n`,
  );
  write(root, "soc2-evidence/tenant-isolation/tenant-isolation-evidence.md", "# Tenant isolation evidence\n");
}

function writePrivateDecision(root: string, relativePath: string, record: Record<string, unknown>) {
  write(
    root,
    path.join("SchoolPilot-SOC2-Evidence", relativePath),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

function writeReadyIncidentPrivateEvidence(root: string) {
  const records = [
    ["credential-rotation", "credential_rotation"],
    ["log-review", "log_review"],
    ["exposure-assessment", "exposure_assessment"],
  ];

  for (const [folder, evidenceType] of records) {
    write(
      root,
      path.join("SchoolPilot-SOC2-Evidence", "incidents", folder, `soc2-001-${folder}.json`),
      `${JSON.stringify({
        incidentId: "SOC2-001-HISTORICAL-CREDENTIAL-EXPOSURE",
        evidenceType,
        status: "ready_for_approval",
        privateDetails: "PRIVATE_INCIDENT_BODY_SHOULD_NOT_APPEAR",
      }, null, 2)}\n`,
    );
  }
}

function writeReadyAiPrivateEvidence(root: string) {
  write(
    root,
    path.join("SchoolPilot-SOC2-Evidence", "ai", "reviews", "soc2-002-ai-data-flow-review.json"),
    `${JSON.stringify({
      evidenceId: "SOC2-002-AI-DATA-FLOW-REVIEW",
      controlId: "SP-CONF-002",
      remediationItem: "SOC2-002",
      evidenceType: "ai_data_flow_review",
      status: "ready_for_approval",
      privateReviewNotes: "PRIVATE_AI_REVIEW_BODY_SHOULD_NOT_APPEAR",
    }, null, 2)}\n`,
  );
}

function writeReadyPrivilegedAccessPrivateEvidence(root: string) {
  write(
    root,
    path.join("SchoolPilot-SOC2-Evidence", "access-reviews", "soc2-003-privileged-access-review.json"),
    `${JSON.stringify({
      evidenceId: "SOC2-003-PRIVILEGED-ACCESS-REVIEW",
      controlId: "SP-SEC-001",
      remediationItem: "SOC2-003",
      evidenceType: "privileged_access_review",
      status: "ready_for_approval",
      privateReviewNotes: "PRIVATE_USER_EXPORT_BODY_SHOULD_NOT_APPEAR",
    }, null, 2)}\n`,
  );
  write(
    root,
    path.join("SchoolPilot-SOC2-Evidence", "access-reviews", "exports", "soc2-003-user-role-export.json"),
    `${JSON.stringify({
      evidenceId: "SOC2-003-USER-ROLE-EXPORT",
      controlId: "SP-SEC-001",
      remediationItem: "SOC2-003",
      evidenceType: "user_role_export",
      status: "ready_for_approval",
      privateUserRows: "PRIVATE_USER_EXPORT_BODY_SHOULD_NOT_APPEAR",
    }, null, 2)}\n`,
  );
}

function writeReadyMonitoringPrivateEvidence(root: string) {
  write(
    root,
    path.join("SchoolPilot-SOC2-Evidence", "monitoring", "reviews", "soc2-monthly-monitoring-review.json"),
    `${JSON.stringify({
      evidenceId: "SOC2-MONTHLY-MONITORING-REVIEW",
      approvalId: "APPROVAL-SP-AVL-002-MONTHLY-MONITORING-REVIEW",
      controlId: "SP-AVL-002",
      remediationItem: "SOC2-008",
      evidenceType: "monthly_monitoring_review",
      status: "ready_for_approval",
      privateReviewNotes: "PRIVATE_MONITORING_REVIEW_BODY_SHOULD_NOT_APPEAR",
    }, null, 2)}\n`,
  );
  write(
    root,
    path.join("SchoolPilot-SOC2-Evidence", "security-events", "reviews", "soc2-monthly-alert-review.json"),
    `${JSON.stringify({
      evidenceId: "SOC2-MONTHLY-ALERT-REVIEW",
      approvalId: "APPROVAL-SP-SEC-003-MONTHLY-ALERT-REVIEW-DECISION",
      controlId: "SP-SEC-003",
      remediationItem: "SOC2-008",
      evidenceType: "monthly_alert_review",
      status: "ready_for_approval",
      privateReviewNotes: "PRIVATE_MONITORING_REVIEW_BODY_SHOULD_NOT_APPEAR",
    }, null, 2)}\n`,
  );
}

function writePrivateReadiness(root: string, now = new Date("2026-06-26T12:00:00Z")) {
  const privateEvidenceDir = path.join(root, "SchoolPilot-SOC2-Evidence");
  fs.mkdirSync(privateEvidenceDir, { recursive: true });
  const packet = buildPrivateEvidenceReadiness({
    rootDir: root,
    privateEvidenceDir,
    now,
  });
  return writePrivateEvidenceReadiness(packet, path.join(root, "soc2-evidence", "private-readiness"));
}

describe("SOC 2 approval queue", () => {
  it("creates JSON and Markdown queue packets with pending approvals", () => {
    const root = tempRoot();
    writeSoc2Docs(root);

    const queue = buildApprovalQueue({
      rootDir: root,
      now: new Date("2026-06-26T12:00:00Z"),
    });
    const outputDir = path.join(root, "soc2-evidence", "approvals");
    const { jsonPath, mdPath } = writeApprovalQueue(queue, outputDir);

    assert.equal(queue.qualityGate.status, "pass");
    assert.ok(fs.existsSync(jsonPath));
    assert.ok(fs.existsSync(mdPath));
    assert.ok(queue.items.length > 0);
    assert.ok(queue.items.every((item) => item.status === "pending_human_approval"));
    assert.ok(queue.items.every((item) => item.appImpact === "No user-facing behavior changed"));
    assert.match(fs.readFileSync(mdPath, "utf8"), /soc2:approval-decision/);
  });

  it("includes every human-approved governance evidence item", () => {
    const root = tempRoot();
    writeSoc2Docs(root);

    const queue = buildApprovalQueue({ rootDir: root, now: new Date("2026-06-26T12:00:00Z") });
    const sourceIds = queue.items.map((item) => item.sourceId);

    assert.ok(sourceIds.includes("SP-SEC-001:Quarterly privileged access review packet"));
    assert.ok(sourceIds.includes("SP-SEC-003:Monthly alert review decision"));
    assert.ok(sourceIds.includes("SP-SEC-003:Incident decision record"));
    assert.ok(sourceIds.includes("SP-SEC-003:Founder-only security training attestation"));
    assert.ok(sourceIds.includes("SP-SEC-005:Vendor DPA confirmation"));
    assert.ok(sourceIds.includes("SP-AVL-001:Restore drill approval"));
    assert.ok(sourceIds.includes("SP-AVL-002:Monthly monitoring review"));
    assert.ok(queue.items.some((item) => item.decisionType === "founder_training_attestation"));
    assert.ok(queue.items.some((item) => item.decisionType === "vendor_dpa_confirmation"));
  });

  it("includes risk acceptance drafts from eligible remediation items", () => {
    const root = tempRoot();
    writeSoc2Docs(root);

    const queue = buildApprovalQueue({ rootDir: root, now: new Date("2026-06-26T12:00:00Z") });
    const riskItems = queue.items.filter((item) => item.decisionType === "risk_acceptance");

    assert.ok(riskItems.some((item) => item.sourceId === "RA-SOC2-001"));
    assert.ok(riskItems.some((item) => item.approvalId === "APPROVAL-SP-SEC-001-PRIVILEGED-MFA-ROLLOUT-DECISION"));
    assert.ok(!riskItems.some((item) => item.sourceId === "RA-SOC2-003"));
    assert.ok(!riskItems.some((item) => item.sourceId === "RA-SOC2-009"));
    assert.ok(riskItems.every((item) => item.expiresAt));
  });

  it("includes deployment approval entries when local deployment evidence exists", () => {
    const root = tempRoot();
    writeSoc2Docs(root);
    writeDeploymentEvidence(root);

    const queue = buildApprovalQueue({
      rootDir: root,
      evidenceDir: path.join(root, "soc2-evidence"),
      now: new Date("2026-06-26T12:00:00Z"),
    });

    const deploymentItem = queue.items.find((item) => item.sourceId === "2026-06-26-shadow-deployment-evidence");
    assert.ok(deploymentItem);
    assert.equal(deploymentItem?.decisionType, "production_deployment_approval");
    assert.equal(deploymentItem?.controlId, "SP-SEC-004");
    assert.match(JSON.stringify(deploymentItem?.evidencePointers), /shadow-deployment-evidence\.json/);
  });

  it("does not create approval items for shadow deployment packets when production deploy is not requested", () => {
    const root = tempRoot();
    writeSoc2Docs(root);
    writeNotRequestedDeploymentEvidence(root);

    const queue = buildApprovalQueue({
      rootDir: root,
      evidenceDir: path.join(root, "soc2-evidence"),
      now: new Date("2026-06-26T12:00:00Z"),
    });

    assert.ok(!queue.items.some((item) => item.sourceId === "2026-06-27-shadow-deployment-evidence"));
  });

  it("includes incident closure and notification approvals when local incident evidence exists", () => {
    const root = tempRoot();
    writeSoc2Docs(root);
    writeIncidentEvidence(root);

    const queue = buildApprovalQueue({
      rootDir: root,
      evidenceDir: path.join(root, "soc2-evidence"),
      now: new Date("2026-06-26T12:00:00Z"),
    });

    const closure = queue.items.find(
      (item) => item.approvalId === "APPROVAL-SP-SEC-003-SOC2-001-HISTORICAL-CREDENTIAL-EXPOSURE-INCIDENT-CLOSURE",
    );
    const notification = queue.items.find(
      (item) => item.approvalId === "APPROVAL-SP-SEC-003-SOC2-001-HISTORICAL-CREDENTIAL-EXPOSURE-NOTIFICATION-DECISION",
    );

    assert.ok(closure);
    assert.ok(notification);
    assert.equal(closure?.decisionType, "incident_decision");
    assert.equal(notification?.decisionType, "notification_decision");
    assert.equal(closure?.status, "pending_human_approval");
    assert.equal(notification?.status, "pending_human_approval");
    assert.deepEqual(closure?.allowedDecisions, ["approved", "not_approved"]);
    assert.deepEqual(notification?.allowedDecisions, ["approved", "not_approved"]);
    assert.match(JSON.stringify(closure?.evidencePointers), /credential-rotation/);
    assert.match(JSON.stringify(notification?.evidencePointers), /log-review/);
  });

  it("includes tenant isolation review approval when local tenant evidence exists", () => {
    const root = tempRoot();
    writeSoc2Docs(root);
    writeTenantIsolationEvidence(root);

    const queue = buildApprovalQueue({
      rootDir: root,
      evidenceDir: path.join(root, "soc2-evidence"),
      now: new Date("2026-06-26T12:00:00Z"),
    });

    const review = queue.items.find(
      (item) => item.approvalId === "APPROVAL-SP-SEC-002-TENANT-ISOLATION-EVIDENCE-REVIEW",
    );

    assert.ok(review);
    assert.equal(review?.decisionType, "tenant_isolation_review");
    assert.equal(review?.status, "pending_human_approval");
    assert.deepEqual(review?.allowedDecisions, ["approved", "not_approved"]);
    assert.match(JSON.stringify(review?.evidencePointers), /soc2-evidence-rls-enabled/);
    assert.match(JSON.stringify(review?.evidencePointers), /pending_private_export/);
  });

  it("uses private readiness to suppress completed approvals and move not-ready items to gaps", () => {
    const root = tempRoot();
    writeSoc2Docs(root);
    writeIncidentEvidence(root);
    writeTenantIsolationEvidence(root);
    writePrivateDecision(root, "risk-acceptances/approved-risk.json", {
      approvalId: "APPROVAL-SP-SEC-001-PRIVILEGED-MFA-ROLLOUT-DECISION",
      controlId: "SP-SEC-001",
      decisionType: "risk_acceptance",
      sourceId: "SP-SEC-001:Privileged MFA rollout decision",
      decision: "approved",
      status: "approved",
      decidedAt: "2026-06-26T13:00:00.000Z",
      expiresAt: "2026-09-25",
      rationale: "PRIVATE_RATIONALE_SHOULD_NOT_APPEAR",
    });
    const { jsonPath: readinessFile } = writePrivateReadiness(root, new Date("2026-06-26T14:00:00Z"));

    const queue = buildApprovalQueue({
      rootDir: root,
      evidenceDir: path.join(root, "soc2-evidence"),
      privateReadinessFile: readinessFile,
      now: new Date("2026-06-27T12:00:00Z"),
    });

    assert.ok(!queue.items.some((item) => item.approvalId === "APPROVAL-RA-SOC2-003-RISK-ACCEPTANCE"));
    assert.ok(!queue.items.some((item) => item.approvalId === "APPROVAL-SP-SEC-001-PRIVILEGED-MFA-ROLLOUT-DECISION"));
    assert.ok(queue.suppressedApprovals.some((item) => item.approvalId === "APPROVAL-SP-SEC-001-PRIVILEGED-MFA-ROLLOUT-DECISION"));
    assert.ok(!queue.items.some(
      (item) => item.approvalId === "APPROVAL-SP-SEC-003-SOC2-001-HISTORICAL-CREDENTIAL-EXPOSURE-INCIDENT-CLOSURE",
    ));
    assert.ok(queue.readinessGaps.some(
      (gap) => gap.approvalId === "APPROVAL-SP-SEC-001-QUARTERLY-PRIVILEGED-ACCESS-REVIEW-PACKET",
    ));
    assert.ok(queue.readinessGaps.some(
      (gap) => gap.approvalId === "APPROVAL-SP-SEC-003-SOC2-001-HISTORICAL-CREDENTIAL-EXPOSURE-INCIDENT-CLOSURE",
    ));
    assert.ok(queue.readinessGaps.some(
      (gap) => gap.approvalId === "APPROVAL-SP-SEC-002-TENANT-ISOLATION-EVIDENCE-REVIEW",
    ));
    assert.ok(queue.readinessGaps.some(
      (gap) => gap.approvalId === "APPROVAL-SP-AVL-002-MONTHLY-MONITORING-REVIEW",
    ));
    assert.ok(queue.readinessGaps.some(
      (gap) => gap.approvalId === "APPROVAL-SP-SEC-003-MONTHLY-ALERT-REVIEW-DECISION",
    ));
    assert.equal(queue.readinessGaps.every((gap) => gap.status === "not_ready"), true);
    assert.doesNotMatch(JSON.stringify(queue), /PRIVATE_RATIONALE_SHOULD_NOT_APPEAR/);
  });

  it("resurfaces expired approved risk acceptances", () => {
    const root = tempRoot();
    writeSoc2Docs(root);
    writePrivateDecision(root, "risk-acceptances/expired-risk.json", {
      approvalId: "APPROVAL-SP-SEC-001-PRIVILEGED-MFA-ROLLOUT-DECISION",
      controlId: "SP-SEC-001",
      decisionType: "risk_acceptance",
      sourceId: "SP-SEC-001:Privileged MFA rollout decision",
      decision: "approved",
      status: "approved",
      decidedAt: "2026-01-01T13:00:00.000Z",
      expiresAt: "2026-01-31",
      rationale: "Expired approval.",
    });
    const { jsonPath: readinessFile } = writePrivateReadiness(root, new Date("2026-06-26T14:00:00Z"));

    const queue = buildApprovalQueue({
      rootDir: root,
      privateReadinessFile: readinessFile,
      now: new Date("2026-06-27T12:00:00Z"),
    });

    assert.ok(queue.items.some((item) => item.approvalId === "APPROVAL-SP-SEC-001-PRIVILEGED-MFA-ROLLOUT-DECISION"));
    assert.ok(!queue.items.some((item) => item.approvalId === "APPROVAL-RA-SOC2-003-RISK-ACCEPTANCE"));
    assert.ok(!queue.suppressedApprovals.some((item) => item.approvalId === "APPROVAL-SP-SEC-001-PRIVILEGED-MFA-ROLLOUT-DECISION"));
  });

  it("preserves secret-free fallback behavior when no private readiness file is supplied", () => {
    const root = tempRoot();
    writeSoc2Docs(root);
    writeIncidentEvidence(root);

    const queue = buildApprovalQueue({
      rootDir: root,
      evidenceDir: path.join(root, "soc2-evidence"),
      now: new Date("2026-06-26T12:00:00Z"),
    });

    assert.ok(queue.items.some(
      (item) => item.approvalId === "APPROVAL-SP-SEC-003-SOC2-001-HISTORICAL-CREDENTIAL-EXPOSURE-INCIDENT-CLOSURE",
    ));
    assert.equal(queue.readinessGaps.length, 0);
    assert.equal(queue.suppressedApprovals.length, 0);
  });

  it("unlocks incident approval items when private incident evidence is ready", () => {
    const root = tempRoot();
    writeSoc2Docs(root);
    writeIncidentEvidence(root);
    writeReadyIncidentPrivateEvidence(root);
    const { jsonPath: readinessFile } = writePrivateReadiness(root, new Date("2026-06-26T14:00:00Z"));

    const queue = buildApprovalQueue({
      rootDir: root,
      evidenceDir: path.join(root, "soc2-evidence"),
      privateReadinessFile: readinessFile,
      now: new Date("2026-06-27T12:00:00Z"),
    });

    assert.ok(queue.items.some(
      (item) => item.approvalId === "APPROVAL-SP-SEC-003-SOC2-001-HISTORICAL-CREDENTIAL-EXPOSURE-INCIDENT-CLOSURE",
    ));
    assert.ok(queue.items.some(
      (item) => item.approvalId === "APPROVAL-SP-SEC-003-SOC2-001-HISTORICAL-CREDENTIAL-EXPOSURE-NOTIFICATION-DECISION",
    ));
    assert.ok(!queue.readinessGaps.some(
      (gap) => gap.approvalId === "APPROVAL-SP-SEC-003-SOC2-001-HISTORICAL-CREDENTIAL-EXPOSURE-INCIDENT-CLOSURE",
    ));
    assert.doesNotMatch(JSON.stringify(queue), /PRIVATE_INCIDENT_BODY_SHOULD_NOT_APPEAR/);
  });

  it("unlocks AI data-flow approval when private AI review evidence is ready", () => {
    const root = tempRoot();
    writeSoc2Docs(root);
    writeReadyAiPrivateEvidence(root);
    const { jsonPath: readinessFile } = writePrivateReadiness(root, new Date("2026-06-26T14:00:00Z"));

    const queue = buildApprovalQueue({
      rootDir: root,
      evidenceDir: path.join(root, "soc2-evidence"),
      privateReadinessFile: readinessFile,
      now: new Date("2026-06-27T12:00:00Z"),
    });

    assert.ok(queue.items.some(
      (item) => item.approvalId === "APPROVAL-SP-CONF-002-AI-DATA-FLOW-REVIEW",
    ));
    assert.ok(!queue.readinessGaps.some(
      (gap) => gap.approvalId === "APPROVAL-SP-CONF-002-AI-DATA-FLOW-REVIEW",
    ));
    assert.doesNotMatch(JSON.stringify(queue), /PRIVATE_AI_REVIEW_BODY_SHOULD_NOT_APPEAR/);
  });

  it("unlocks privileged access review when private access review and export are ready", () => {
    const root = tempRoot();
    writeSoc2Docs(root);
    writeReadyPrivilegedAccessPrivateEvidence(root);
    const { jsonPath: readinessFile } = writePrivateReadiness(root, new Date("2026-06-26T14:00:00Z"));

    const queue = buildApprovalQueue({
      rootDir: root,
      privateReadinessFile: readinessFile,
      now: new Date("2026-06-27T12:00:00Z"),
    });

    assert.ok(queue.items.some(
      (item) => item.approvalId === "APPROVAL-SP-SEC-001-QUARTERLY-PRIVILEGED-ACCESS-REVIEW-PACKET",
    ));
    assert.ok(!queue.readinessGaps.some(
      (gap) => gap.approvalId === "APPROVAL-SP-SEC-001-QUARTERLY-PRIVILEGED-ACCESS-REVIEW-PACKET",
    ));
    assert.doesNotMatch(JSON.stringify(queue), /PRIVATE_USER_EXPORT_BODY_SHOULD_NOT_APPEAR/);
  });

  it("unlocks monthly monitoring and alert approvals when private reviews are ready", () => {
    const root = tempRoot();
    writeSoc2Docs(root);
    writeReadyMonitoringPrivateEvidence(root);
    const { jsonPath: readinessFile } = writePrivateReadiness(root, new Date("2026-06-26T14:00:00Z"));

    const queue = buildApprovalQueue({
      rootDir: root,
      privateReadinessFile: readinessFile,
      now: new Date("2026-06-27T12:00:00Z"),
    });

    const monitoring = queue.items.find(
      (item) => item.approvalId === "APPROVAL-SP-AVL-002-MONTHLY-MONITORING-REVIEW",
    );
    const alert = queue.items.find(
      (item) => item.approvalId === "APPROVAL-SP-SEC-003-MONTHLY-ALERT-REVIEW-DECISION",
    );

    assert.ok(monitoring);
    assert.ok(alert);
    assert.equal(monitoring?.decisionType, "monitoring_review");
    assert.equal(alert?.decisionType, "monitoring_review");
    assert.equal(monitoring?.expiresAt, "2026-06-30");
    assert.equal(alert?.expiresAt, "2026-06-30");
    assert.ok(!queue.readinessGaps.some(
      (gap) => gap.approvalId === "APPROVAL-SP-AVL-002-MONTHLY-MONITORING-REVIEW",
    ));
    assert.ok(!queue.readinessGaps.some(
      (gap) => gap.approvalId === "APPROVAL-SP-SEC-003-MONTHLY-ALERT-REVIEW-DECISION",
    ));
    assert.doesNotMatch(JSON.stringify(queue), /PRIVATE_MONITORING_REVIEW_BODY_SHOULD_NOT_APPEAR/);
  });

  it("suppresses completed monthly reviews only until their expiration", () => {
    const root = tempRoot();
    writeSoc2Docs(root);
    writeReadyMonitoringPrivateEvidence(root);
    writePrivateDecision(root, "monitoring/reviews/approved-monitoring-review.json", {
      approvalId: "APPROVAL-SP-AVL-002-MONTHLY-MONITORING-REVIEW",
      controlId: "SP-AVL-002",
      decisionType: "monitoring_review",
      sourceId: "SP-AVL-002:Monthly monitoring review",
      decision: "approved",
      status: "approved",
      decidedAt: "2026-06-27T13:00:00.000Z",
      expiresAt: "2026-06-30",
      rationale: "PRIVATE_RATIONALE_SHOULD_NOT_APPEAR",
    });
    const { jsonPath: readinessFile } = writePrivateReadiness(root, new Date("2026-06-27T14:00:00Z"));

    const currentMonthQueue = buildApprovalQueue({
      rootDir: root,
      privateReadinessFile: readinessFile,
      now: new Date("2026-06-28T12:00:00Z"),
    });
    const nextMonthQueue = buildApprovalQueue({
      rootDir: root,
      privateReadinessFile: readinessFile,
      now: new Date("2026-07-01T12:00:00Z"),
    });

    assert.ok(!currentMonthQueue.items.some(
      (item) => item.approvalId === "APPROVAL-SP-AVL-002-MONTHLY-MONITORING-REVIEW",
    ));
    assert.ok(currentMonthQueue.suppressedApprovals.some(
      (item) => item.approvalId === "APPROVAL-SP-AVL-002-MONTHLY-MONITORING-REVIEW",
    ));
    assert.ok(nextMonthQueue.items.some(
      (item) => item.approvalId === "APPROVAL-SP-AVL-002-MONTHLY-MONITORING-REVIEW",
    ));
    assert.ok(!nextMonthQueue.suppressedApprovals.some(
      (item) => item.approvalId === "APPROVAL-SP-AVL-002-MONTHLY-MONITORING-REVIEW",
    ));
    assert.doesNotMatch(JSON.stringify(currentMonthQueue), /PRIVATE_RATIONALE_SHOULD_NOT_APPEAR/);
  });

  it("suppresses completed AI data-flow decisions from the pending queue", () => {
    const root = tempRoot();
    writeSoc2Docs(root);
    writePrivateDecision(root, "ai/reviews/approved-ai-review.json", {
      approvalId: "APPROVAL-SP-CONF-002-AI-DATA-FLOW-REVIEW",
      controlId: "SP-CONF-002",
      decisionType: "ai_data_flow_review",
      sourceId: "SP-CONF-002:AI data-flow review",
      decision: "approved",
      status: "approved",
      decidedAt: "2026-06-26T13:00:00.000Z",
      rationale: "PRIVATE_RATIONALE_SHOULD_NOT_APPEAR",
    });
    const { jsonPath: readinessFile } = writePrivateReadiness(root, new Date("2026-06-26T14:00:00Z"));

    const queue = buildApprovalQueue({
      rootDir: root,
      privateReadinessFile: readinessFile,
      now: new Date("2026-06-27T12:00:00Z"),
    });

    assert.ok(!queue.items.some((item) => item.approvalId === "APPROVAL-SP-CONF-002-AI-DATA-FLOW-REVIEW"));
    assert.ok(queue.suppressedApprovals.some((item) => item.approvalId === "APPROVAL-SP-CONF-002-AI-DATA-FLOW-REVIEW"));
    assert.doesNotMatch(JSON.stringify(queue), /PRIVATE_RATIONALE_SHOULD_NOT_APPEAR/);
  });

  it("uses evidence pointers without copying private document contents", () => {
    const root = tempRoot();
    writeSoc2Docs(root);
    write(root, "private-contracts/vendor-dpa.txt", "PRIVATE_CONTRACT_BODY");

    const queue = buildApprovalQueue({ rootDir: root, now: new Date("2026-06-26T12:00:00Z") });
    const outputDir = path.join(root, "soc2-evidence", "approvals");
    const { jsonPath, mdPath } = writeApprovalQueue(queue, outputDir);
    const serialized = `${fs.readFileSync(jsonPath, "utf8")}\n${fs.readFileSync(mdPath, "utf8")}`;

    assert.doesNotMatch(serialized, /PRIVATE_CONTRACT_BODY/);
    assert.match(serialized, /SchoolPilot-SOC2-Evidence\/vendors\/dpas\//);
  });

  it("records approved decisions to a private evidence repo", () => {
    const root = tempRoot();
    writeSoc2Docs(root);
    const queue = buildApprovalQueue({ rootDir: root, now: new Date("2026-06-26T12:00:00Z") });
    const { jsonPath: queueFile } = writeApprovalQueue(queue, path.join(root, "soc2-evidence", "approvals"));
    const privateEvidenceDir = path.join(root, "SchoolPilot-SOC2-Evidence");
    fs.mkdirSync(privateEvidenceDir, { recursive: true });
    const riskItem = queue.items.find((item) => item.sourceId === "RA-SOC2-001");
    assert.ok(riskItem);

    const { record, jsonPath, mdPath } = recordApprovalDecision({
      rootDir: root,
      queueFile,
      privateEvidenceDir,
      approvalId: riskItem!.approvalId,
      decision: "approved",
      approverName: "Brian Zinkan",
      rationale: "Accepted for first test-school observation window with documented compensating controls.",
      now: new Date("2026-06-26T13:00:00Z"),
    });

    assert.equal(record.decision, "approved");
    assert.equal(record.status, "approved");
    assert.equal(record.appImpact, "No user-facing behavior changed");
    assert.ok(record.evidencePointers.length > 0);
    assert.match(jsonPath, /risk-acceptances/);
    assert.ok(fs.existsSync(jsonPath));
    assert.ok(fs.existsSync(mdPath));
  });

  it("records tenant isolation review decisions to the tenant-isolation private folder", () => {
    const root = tempRoot();
    writeSoc2Docs(root);
    writeTenantIsolationEvidence(root);
    const queue = buildApprovalQueue({
      rootDir: root,
      evidenceDir: path.join(root, "soc2-evidence"),
      now: new Date("2026-06-26T12:00:00Z"),
    });
    const { jsonPath: queueFile } = writeApprovalQueue(queue, path.join(root, "soc2-evidence", "approvals"));
    const privateEvidenceDir = path.join(root, "SchoolPilot-SOC2-Evidence");
    fs.mkdirSync(privateEvidenceDir, { recursive: true });

    const { record, jsonPath, mdPath } = recordApprovalDecision({
      rootDir: root,
      queueFile,
      privateEvidenceDir,
      approvalId: "APPROVAL-SP-SEC-002-TENANT-ISOLATION-EVIDENCE-REVIEW",
      decision: "not_approved",
      approverName: "Brian Zinkan",
      rationale: "Production RLS export evidence is still pending.",
      now: new Date("2026-06-26T13:00:00Z"),
    });

    assert.equal(record.decision, "not_approved");
    assert.equal(record.decisionType, "tenant_isolation_review");
    assert.match(jsonPath, /tenant-isolation/);
    assert.ok(fs.existsSync(jsonPath));
    assert.ok(fs.existsSync(mdPath));
  });

  it("records AI data-flow review decisions to the ai/reviews private folder", () => {
    const root = tempRoot();
    writeSoc2Docs(root);
    const queue = buildApprovalQueue({
      rootDir: root,
      now: new Date("2026-06-26T12:00:00Z"),
    });
    const { jsonPath: queueFile } = writeApprovalQueue(queue, path.join(root, "soc2-evidence", "approvals"));
    const privateEvidenceDir = path.join(root, "SchoolPilot-SOC2-Evidence");
    fs.mkdirSync(privateEvidenceDir, { recursive: true });

    const { record, jsonPath, mdPath } = recordApprovalDecision({
      rootDir: root,
      queueFile,
      privateEvidenceDir,
      approvalId: "APPROVAL-SP-CONF-002-AI-DATA-FLOW-REVIEW",
      decision: "not_approved",
      approverName: "Brian Zinkan",
      rationale: "Private AI review remains incomplete.",
      now: new Date("2026-06-26T13:00:00Z"),
    });

    assert.equal(record.decision, "not_approved");
    assert.equal(record.decisionType, "ai_data_flow_review");
    assert.match(jsonPath, /ai[\\/]reviews/);
    assert.ok(fs.existsSync(jsonPath));
    assert.ok(fs.existsSync(mdPath));
  });

  it("records monthly alert review decisions to the security-events reviews private folder", () => {
    const root = tempRoot();
    writeSoc2Docs(root);
    const queue = buildApprovalQueue({
      rootDir: root,
      now: new Date("2026-06-26T12:00:00Z"),
    });
    const { jsonPath: queueFile } = writeApprovalQueue(queue, path.join(root, "soc2-evidence", "approvals"));
    const privateEvidenceDir = path.join(root, "SchoolPilot-SOC2-Evidence");
    fs.mkdirSync(privateEvidenceDir, { recursive: true });

    const { record, jsonPath, mdPath } = recordApprovalDecision({
      rootDir: root,
      queueFile,
      privateEvidenceDir,
      approvalId: "APPROVAL-SP-SEC-003-MONTHLY-ALERT-REVIEW-DECISION",
      decision: "approved",
      approverName: "Brian Zinkan",
      rationale: "Monthly security alert review completed for the current review period.",
      now: new Date("2026-06-26T13:00:00Z"),
    });

    assert.equal(record.decision, "approved");
    assert.equal(record.decisionType, "monitoring_review");
    assert.equal(record.expiresAt, "2026-06-30");
    assert.match(jsonPath, /security-events[\\/]reviews/);
    assert.ok(fs.existsSync(jsonPath));
    assert.ok(fs.existsSync(mdPath));
  });

  it("rejects invalid decisions, missing rationale, and missing private evidence storage", () => {
    const root = tempRoot();
    writeSoc2Docs(root);
    const queue = buildApprovalQueue({ rootDir: root, now: new Date("2026-06-26T12:00:00Z") });
    const { jsonPath: queueFile } = writeApprovalQueue(queue, path.join(root, "soc2-evidence", "approvals"));
    const privateEvidenceDir = path.join(root, "SchoolPilot-SOC2-Evidence");
    fs.mkdirSync(privateEvidenceDir, { recursive: true });
    const item = queue.items[0];

    assert.throws(
      () => recordApprovalDecision({
        rootDir: root,
        queueFile,
        privateEvidenceDir,
        approvalId: item.approvalId,
        decision: "maybe",
        approverName: "Brian Zinkan",
        rationale: "No.",
      }),
      /approved or not_approved/,
    );

    assert.throws(
      () => recordApprovalDecision({
        rootDir: root,
        queueFile,
        privateEvidenceDir,
        approvalId: item.approvalId,
        decision: "not_approved",
        approverName: "",
        rationale: "",
      }),
      /Approver is required/,
    );

    assert.throws(
      () => recordApprovalDecision({
        rootDir: root,
        queueFile,
        privateEvidenceDir: path.join(root, "missing-private-evidence"),
        approvalId: item.approvalId,
        decision: "approved",
        approverName: "Brian Zinkan",
        rationale: "Approving with evidence.",
      }),
      /Private evidence directory does not exist/,
    );
  });
});
