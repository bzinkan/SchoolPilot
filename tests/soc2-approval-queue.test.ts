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
    assert.ok(sourceIds.includes("SP-SEC-003:Incident decision record"));
    assert.ok(sourceIds.includes("SP-SEC-003:Founder-only security training attestation"));
    assert.ok(sourceIds.includes("SP-SEC-005:Vendor DPA confirmation"));
    assert.ok(sourceIds.includes("SP-AVL-001:Restore drill approval"));
    assert.ok(queue.items.some((item) => item.decisionType === "founder_training_attestation"));
    assert.ok(queue.items.some((item) => item.decisionType === "vendor_dpa_confirmation"));
  });

  it("includes risk acceptance drafts from eligible remediation items", () => {
    const root = tempRoot();
    writeSoc2Docs(root);

    const queue = buildApprovalQueue({ rootDir: root, now: new Date("2026-06-26T12:00:00Z") });
    const riskItems = queue.items.filter((item) => item.decisionType === "risk_acceptance");

    assert.ok(riskItems.some((item) => item.sourceId === "RA-SOC2-001"));
    assert.ok(riskItems.some((item) => item.sourceId === "RA-SOC2-003"));
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
