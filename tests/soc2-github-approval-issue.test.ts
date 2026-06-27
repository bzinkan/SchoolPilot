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
    readinessGapCount: 0,
    suppressedApprovalCount: 0,
    appImpact: "No user-facing behavior changed",
    readinessGaps: [],
    suppressedApprovals: [],
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

  it("formats readiness gaps without approval commands", () => {
    const pendingQueue = {
      ...queue(),
      itemCount: 0,
      readinessGapCount: 1,
      suppressedApprovalCount: 1,
      items: [],
      suppressedApprovals: [
        {
          approvalId: "APPROVAL-RA-SOC2-002-RISK-ACCEPTANCE",
          decision: "approved",
        },
      ],
      readinessGaps: [
        {
          approvalId: "APPROVAL-SP-SEC-002-TENANT-ISOLATION-EVIDENCE-REVIEW",
          controlId: "SP-SEC-002",
          decisionType: "tenant_isolation_review",
          sourceId: "TENANT-ISOLATION-EVIDENCE",
          status: "not_ready",
          reason: "Required private evidence is missing.",
          missingEvidence: ["Production RLS status export"],
          requiredEvidence: [
            {
              label: "Production RLS status export",
              location: "SchoolPilot-SOC2-Evidence/tenant-isolation/production-rls-export/",
              present: false,
            },
          ],
          appImpact: "No user-facing behavior changed",
        },
      ],
    };

    const body = formatApprovalIssueBody(pendingQueue);

    assert.match(body, /Readiness gaps: 1/);
    assert.match(body, /Gap: APPROVAL-SP-SEC-002-TENANT-ISOLATION-EVIDENCE-REVIEW/);
    assert.match(body, /Production RLS status export: missing/);
    assert.doesNotMatch(body, /\/approve APPROVAL-SP-SEC-002-TENANT-ISOLATION-EVIDENCE-REVIEW/);
    assert.doesNotMatch(body, /\/reject APPROVAL-SP-SEC-002-TENANT-ISOLATION-EVIDENCE-REVIEW/);
  });

  it("formats AI readiness gaps without approval commands", () => {
    const pendingQueue = {
      ...queue(),
      itemCount: 0,
      readinessGapCount: 1,
      items: [],
      readinessGaps: [
        {
          approvalId: "APPROVAL-SP-CONF-002-AI-DATA-FLOW-REVIEW",
          controlId: "SP-CONF-002",
          decisionType: "ai_data_flow_review",
          sourceId: "SP-CONF-002:AI data-flow review",
          status: "not_ready",
          reason: "Required private evidence is missing.",
          missingEvidence: ["AI data-flow review"],
          requiredEvidence: [
            {
              label: "AI data-flow review",
              location: "SchoolPilot-SOC2-Evidence/ai/reviews/",
              present: false,
            },
          ],
          appImpact: "No user-facing behavior changed",
        },
      ],
    };

    const body = formatApprovalIssueBody(pendingQueue);

    assert.match(body, /Gap: APPROVAL-SP-CONF-002-AI-DATA-FLOW-REVIEW/);
    assert.match(body, /AI data-flow review: missing/);
    assert.doesNotMatch(body, /\/approve APPROVAL-SP-CONF-002-AI-DATA-FLOW-REVIEW/);
    assert.doesNotMatch(body, /\/reject APPROVAL-SP-CONF-002-AI-DATA-FLOW-REVIEW/);
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
