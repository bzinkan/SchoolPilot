import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildRiskAcceptanceDrafts,
  buildGovernanceEvidence,
  parseMarkdownTable,
  scanPublicClaimFiles,
  validateRiskAcceptancePolicy,
  validateGovernanceDocument,
} from "../scripts/soc2/check-governance-evidence.mjs";

const REQUIRED_CONTROLS = [
  "SP-SEC-001",
  "SP-SEC-002",
  "SP-SEC-003",
  "SP-SEC-004",
  "SP-SEC-005",
  "SP-AVL-001",
  "SP-AVL-002",
  "SP-CONF-001",
  "SP-CONF-002",
];

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schoolpilot-soc2-"));
  fs.mkdirSync(path.join(root, "docs", "soc2"), { recursive: true });
  return root;
}

function write(root: string, relativePath: string, contents: string) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, contents);
}

function control(id: string, evidence = [{ name: "CI packet", automation: "automated", privateEvidenceLocation: "artifact" }]) {
  return {
    id,
    owner: id === "SP-SEC-001" ? "Security & Privacy Officer" : "Engineering",
    status: "Implementing",
    frequency: "Continuous",
    nextReviewDue: "2026-09-30",
    automationImpact: "No user-facing workflow changes.",
    evidence,
  };
}

function validGovernanceDoc() {
  return {
    schemaVersion: 1,
    evidenceRepository: "SchoolPilot-SOC2-Evidence",
    humanApprovalBoundary: "Human approvals are tracked but never automated.",
    controls: REQUIRED_CONTROLS.map((id) => control(id)),
  };
}

function validRiskPolicy() {
  return {
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
      "Privileged access": ["Perform manual privileged access review", "Keep in-app MFA claim deferred"],
    },
  };
}

function writeMinimalRegisters(root: string) {
  write(
    root,
    "docs/soc2/remediation-register.md",
    `# Remediation

| ID | Priority | Area | Gap | Owner | Target | Evidence Needed | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SOC2-001 | P0 | Incident response | Needs record. | Security | Before observation | Incident record | Open |
`,
  );
  write(
    root,
    "docs/soc2/claim-register.md",
    `# Claims

| Claim ID | Source | Claim | Owner | Evidence Required | Status | Action |
| --- | --- | --- | --- | --- | --- | --- |
| CLAIM-001 | Security page | SOC 2 Type II is planned, not completed. | Security | CPA readiness plan | Supported | Keep readiness wording |
`,
  );
}

describe("SOC 2 governance evidence checker", () => {
  it("parses markdown register tables", () => {
    const rows = parseMarkdownTable(`
| ID | Status |
| --- | --- |
| SOC2-001 | Open |
`);

    assert.deepEqual(rows, [{ ID: "SOC2-001", Status: "Open" }]);
  });

  it("fails malformed governance metadata", () => {
    const result = validateGovernanceDocument(
      {
        schemaVersion: 1,
        evidenceRepository: "SchoolPilot-SOC2-Evidence",
        humanApprovalBoundary: "Humans approve decisions.",
        controls: [
          {
            id: "SP-SEC-001",
            status: "Ready",
            frequency: "Quarterly",
            nextReviewDue: "2026-09-30",
            automationImpact: "No app change.",
            evidence: [],
          },
        ],
      },
      ["SP-SEC-001"],
    );

    assert.match(result.errors.join("\n"), /owner/);
    assert.match(result.errors.join("\n"), /at least one evidence item/);
  });

  it("warns on pending human approvals without failing", () => {
    const doc = validGovernanceDoc();
    doc.controls[0] = control("SP-SEC-001", [
      {
        name: "Risk acceptance",
        automation: "human_approved",
        privateEvidenceLocation: "SchoolPilot-SOC2-Evidence/risk-acceptances/",
        humanApproverRole: "Management",
      },
    ]);

    const result = validateGovernanceDocument(doc);

    assert.deepEqual(result.errors, []);
    assert.equal(result.pendingHumanApprovals.length, 1);
    assert.match(result.warnings.join("\n"), /Human approval pending/);
  });

  it("validates risk acceptance automation policy", () => {
    const result = validateRiskAcceptancePolicy({
      schemaVersion: 1,
      owner: "Founder",
      approverRole: "Founder",
      privateEvidenceLocation: "SchoolPilot-SOC2-Evidence/risk-acceptances/",
      draftStatus: "Draft - pending founder approval",
      defaultExpirationDays: 90,
      autoDraftPriorities: ["P0"],
      autoDraftStatuses: ["Open"],
    });

    assert.deepEqual(result.errors, []);
  });

  it("drafts risk acceptances from eligible remediation items", () => {
    const rows = parseMarkdownTable(`
| ID | Priority | Area | Gap | Owner | Target | Evidence Needed | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SOC2-003 | P0 | Privileged access | MFA deferred. | Engineering | Before observation | Risk acceptance | Open |
| SOC2-009 | P2 | Mobile | Storage hardening. | Engineering | Before observation | Build config | Open |
`);

    const drafts = buildRiskAcceptanceDrafts(rows, validRiskPolicy(), new Date("2026-06-26T00:00:00Z"));

    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].riskId, "RA-SOC2-003");
    assert.equal(drafts[0].status, "Draft - pending founder approval");
    assert.equal(drafts[0].expirationDate, "2026-09-24");
    assert.match(drafts[0].automationNote, /Founder approval is still required/);
  });

  it("fails when public docs overstate SOC 2 readiness", () => {
    const root = tempRoot();
    write(
      root,
      "docs/v1-SCHOOLPILOT-PRINCIPAL-IT-REVIEW.md",
      "All technical controls a SOC 2 auditor would expect are in place.",
    );

    const result = scanPublicClaimFiles(root);

    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /overstated SOC 2 readiness/);
  });

  it("builds a passing packet when only human approvals are pending", () => {
    const root = tempRoot();
    const doc = validGovernanceDoc();
    doc.controls[0] = control("SP-SEC-001", [
      {
        name: "Quarterly access review approval",
        automation: "human_approved",
        privateEvidenceLocation: "SchoolPilot-SOC2-Evidence/access-reviews/",
        humanApproverRole: "Security & Privacy Officer",
      },
    ]);

    write(root, "docs/soc2/governance-controls.json", `${JSON.stringify(doc, null, 2)}\n`);
    write(root, "docs/soc2/risk-acceptance-policy.json", `${JSON.stringify(validRiskPolicy(), null, 2)}\n`);
    writeMinimalRegisters(root);

    const packet = buildGovernanceEvidence({
      rootDir: root,
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "bzinkan/SchoolPilot",
        GITHUB_WORKFLOW: "CI",
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_SERVER_URL: "https://github.com",
      },
    });

    assert.equal(packet.qualityGate.status, "pass");
    assert.deepEqual(packet.qualityGate.errors, []);
    assert.equal(packet.pendingHumanApprovals.length, 1);
    assert.equal(packet.riskAcceptance.draftCount, 1);
    assert.match(packet.appImpact, /No user-facing app/);
  });
});
