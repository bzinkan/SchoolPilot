import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractIssueMetadata,
  formatApprovalIssueBody,
  parseApprovalComment,
} from "../scripts/soc2/github-approval-issue.mjs";

function queue() {
  return {
    queueId: "2026-06-26T20-00-00-000Z-soc2-approval-queue",
    generatedAt: "2026-06-26T20:00:00.000Z",
    runId: "123",
    runAttempt: "1",
    runUrl: "https://github.com/bzinkan/SchoolPilot/actions/runs/123",
    itemCount: 2,
    appImpact: "No user-facing behavior changed",
    items: [
      {
        approvalId: "APPROVAL-SP-SEC-004-PRODUCTION-DEPLOYMENT-APPROVAL",
        controlId: "SP-SEC-004",
        decisionType: "production_deployment_approval",
        sourceId: "SP-SEC-004:Production deployment approval",
        status: "pending_human_approval",
        recommendedDecision: "manual_review",
        approverRole: "Founder",
        expiresAt: null,
        appImpact: "No user-facing behavior changed",
        evidencePointers: [
          { label: "Workflow run", location: "https://github.com/bzinkan/SchoolPilot/actions/runs/123" },
        ],
      },
      {
        approvalId: "APPROVAL-SP-SEC-005-VENDOR-DPA-CONFIRMATION",
        controlId: "SP-SEC-005",
        decisionType: "vendor_dpa_confirmation",
        sourceId: "SP-SEC-005:Vendor DPA confirmation",
        status: "pending_human_approval",
        recommendedDecision: "manual_review",
        approverRole: "Founder",
        expiresAt: null,
        appImpact: "No user-facing behavior changed",
        evidencePointers: [
          { label: "Private evidence location", location: "SchoolPilot-SOC2-Evidence/vendors/dpas/" },
        ],
      },
    ],
  };
}

describe("SOC 2 GitHub approval issue", () => {
  it("formats a GitHub issue body with metadata and slash commands", () => {
    const body = formatApprovalIssueBody(queue(), {
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "bzinkan/SchoolPilot",
      GITHUB_RUN_ID: "456",
      GITHUB_RUN_ATTEMPT: "2",
    });

    assert.match(body, /SOC 2 Approvals Pending/);
    assert.match(body, /\/approve APPROVAL-SP-SEC-004-PRODUCTION-DEPLOYMENT-APPROVAL/);
    assert.match(body, /\/reject APPROVAL-SP-SEC-005-VENDOR-DPA-CONFIRMATION/);
    assert.match(body, /No user-facing behavior changed/);

    const metadata = extractIssueMetadata(body);
    assert.equal(metadata?.queueId, "2026-06-26T20-00-00-000Z-soc2-approval-queue");
    assert.equal(metadata?.runId, "456");
    assert.equal(metadata?.artifactName, "soc2-approval-queue");
  });

  it("parses authorized approve commands", () => {
    const issueBody = formatApprovalIssueBody(queue());
    const result = parseApprovalComment({
      commentBody: "/approve APPROVAL-SP-SEC-004-PRODUCTION-DEPLOYMENT-APPROVAL CI green and evidence reviewed.",
      actor: "bzinkan",
      issueBody,
      authorizedActors: ["bzinkan"],
    });

    assert.equal(result.shouldProcess, true);
    assert.equal(result.decision, "approved");
    assert.equal(result.approvalId, "APPROVAL-SP-SEC-004-PRODUCTION-DEPLOYMENT-APPROVAL");
    assert.equal(result.rationale, "CI green and evidence reviewed.");
    assert.equal(result.artifactName, "soc2-approval-queue");
  });

  it("parses authorized reject commands as not_approved", () => {
    const issueBody = formatApprovalIssueBody(queue());
    const result = parseApprovalComment({
      commentBody: "/reject APPROVAL-SP-SEC-005-VENDOR-DPA-CONFIRMATION DPA is not present in private evidence yet.",
      actor: "bzinkan",
      issueBody,
      authorizedActors: ["bzinkan"],
    });

    assert.equal(result.shouldProcess, true);
    assert.equal(result.decision, "not_approved");
    assert.equal(result.approvalId, "APPROVAL-SP-SEC-005-VENDOR-DPA-CONFIRMATION");
  });

  it("rejects unauthorized actors", () => {
    const issueBody = formatApprovalIssueBody(queue());
    const result = parseApprovalComment({
      commentBody: "/approve APPROVAL-SP-SEC-004-PRODUCTION-DEPLOYMENT-APPROVAL Looks good.",
      actor: "someone-else",
      issueBody,
      authorizedActors: ["bzinkan"],
    });

    assert.equal(result.shouldProcess, false);
    assert.match(result.error || "", /not authorized/);
  });

  it("rejects issue comments without approval queue metadata", () => {
    const result = parseApprovalComment({
      commentBody: "/approve APPROVAL-SP-SEC-004-PRODUCTION-DEPLOYMENT-APPROVAL Looks good.",
      actor: "bzinkan",
      issueBody: "# Regular issue",
      authorizedActors: ["bzinkan"],
    });

    assert.equal(result.shouldProcess, false);
    assert.match(result.error || "", /metadata/);
  });

  it("ignores non-command comments", () => {
    const issueBody = formatApprovalIssueBody(queue());
    const result = parseApprovalComment({
      commentBody: "LGTM",
      actor: "bzinkan",
      issueBody,
      authorizedActors: ["bzinkan"],
    });

    assert.equal(result.shouldProcess, false);
    assert.match(result.error || "", /not a SOC 2 approval command/);
  });
});
