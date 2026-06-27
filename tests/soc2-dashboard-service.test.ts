import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";

import {
  buildSoc2DashboardReadiness,
  dispatchSoc2DashboardResync,
  parseApprovalIssueBody,
  parseRecordedDecisionComments,
} from "../src/services/soc2Dashboard.js";

const APP_IMPACT = "No user-facing behavior changed";

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schoolpilot-soc2-dashboard-"));
  fs.mkdirSync(path.join(root, "docs", "soc2"), { recursive: true });
  return root;
}

function write(root: string, relativePath: string, contents: string) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, contents);
}

function writeSoc2Docs(root: string) {
  write(
    root,
    "docs/soc2/governance-controls.json",
    `${JSON.stringify({
      controls: [
        {
          id: "SP-SEC-001",
          owner: "Security & Privacy Officer",
          status: "Implementing",
          frequency: "Quarterly",
          nextReviewDue: "2026-09-30",
          automationImpact: APP_IMPACT,
        },
        {
          id: "SP-SEC-004",
          owner: "Engineering",
          status: "Ready",
          frequency: "Every change",
          nextReviewDue: "Continuous",
          automationImpact: APP_IMPACT,
        },
      ],
    }, null, 2)}\n`,
  );
  write(
    root,
    "docs/soc2/remediation-register.md",
    `# SOC 2 Remediation Register

| ID | Priority | Area | Gap | Owner | Target | Evidence Needed | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SOC2-003 | P0 | Privileged access | MFA deferred. | Engineering | Before observation | Access review | In progress |
| SOC2-001 | P0 | Incident response | Historical issue closed. | Security | Complete | Closure decision | Closed |
`,
  );
  write(
    root,
    "docs/soc2/claim-register.md",
    `# SOC 2 Claim Register

| Claim ID | Source | Claim | Owner | Evidence Needed | Status | Action |
| --- | --- | --- | --- | --- | --- | --- |
| CLAIM-001 | Security page | Evidence is in progress. | Security | Dashboard evidence | Needs evidence | Add evidence |
| CLAIM-002 | HECVAT | SOC 2 planned. | Security | CPA plan | Supported | Keep wording |
`,
  );
}

function approvalIssueBody() {
  return `# SOC 2 Approvals Pending

- Queue ID: 2026-06-27T10-00-00-000Z-soc2-approval-queue
- Pending approvals: 1
- Readiness gaps: 1
- Suppressed completed decisions: 2
- Generated at: 2026-06-27T10:00:00.000Z
- Source run: https://github.com/bzinkan/SchoolPilot/actions/runs/123
- Artifact: soc2-approval-queue
- App impact: ${APP_IMPACT}

## Pending Items

### APPROVAL-SP-SEC-001-PRIVILEGED-MFA-ROLLOUT-DECISION

- Control: SP-SEC-001
- Decision type: risk_acceptance
- Status: pending_human_approval
- Recommended decision: approved
- Approver role: Founder
- Expires: 2026-09-30
- App impact: ${APP_IMPACT}
- Evidence pointers:
  - Private evidence location: SchoolPilot-SOC2-Evidence/risk-acceptances/
  - Workflow run: https://github.com/bzinkan/SchoolPilot/actions/runs/123

Approve:

\`\`\`text
/approve APPROVAL-SP-SEC-001-PRIVILEGED-MFA-ROLLOUT-DECISION Privileged access reviewed and MFA deferral accepted.
\`\`\`

Reject:

\`\`\`text
/reject APPROVAL-SP-SEC-001-PRIVILEGED-MFA-ROLLOUT-DECISION MFA deferral is not accepted.
\`\`\`

## Private Evidence Readiness Gaps

### Gap: APPROVAL-SP-CONF-002-AI-DATA-FLOW-REVIEW

- Control: SP-CONF-002
- Decision type: ai_data_flow_review
- Status: not_ready
- Reason: Required private evidence is missing.
- App impact: ${APP_IMPACT}
- Required private evidence:
  - AI data-flow review: missing (SchoolPilot-SOC2-Evidence/ai/reviews/)
`;
}

describe("SOC 2 dashboard service", () => {
  it("parses the SOC 2 approval issue into pending approvals and readiness gaps", () => {
    const parsed = parseApprovalIssueBody(approvalIssueBody());

    assert.equal(parsed.queueMetadata.pendingApprovals, 1);
    assert.equal(parsed.queueMetadata.readinessGaps, 1);
    assert.equal(parsed.queueMetadata.suppressedCompletedDecisions, 2);
    assert.equal(parsed.pendingApprovals.length, 1);
    assert.equal(parsed.pendingApprovals[0]?.approvalId, "APPROVAL-SP-SEC-001-PRIVILEGED-MFA-ROLLOUT-DECISION");
    assert.equal(parsed.pendingApprovals[0]?.controlId, "SP-SEC-001");
    assert.equal(parsed.pendingApprovals[0]?.approveCommand.startsWith("/approve APPROVAL-SP-SEC-001"), true);
    assert.equal(parsed.pendingApprovals[0]?.evidencePointers.length, 2);
    assert.equal(parsed.readinessGaps.length, 1);
    assert.equal(parsed.readinessGaps[0]?.approvalId, "APPROVAL-SP-CONF-002-AI-DATA-FLOW-REVIEW");
    assert.equal(parsed.readinessGaps[0]?.requiredEvidence[0]?.location, "SchoolPilot-SOC2-Evidence/ai/reviews/");
  });

  it("parses recorded decision comments without exposing private rationale text", () => {
    const decisions = parseRecordedDecisionComments([
      {
        body: [
          "Recorded SOC 2 decision `approved` for `APPROVAL-SP-SEC-001-PRIVILEGED-MFA-ROLLOUT-DECISION` by @bzinkan.",
          "",
          "Private rationale: PRIVATE_RATIONALE_SHOULD_NOT_APPEAR",
        ].join("\n"),
        created_at: "2026-06-27T10:10:00.000Z",
        html_url: "https://github.com/bzinkan/SchoolPilot/issues/146#issuecomment-1",
        user: { login: "github-actions[bot]" },
      },
    ]);

    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.decision, "approved");
    assert.equal(decisions[0]?.actor, "bzinkan");
    assert.doesNotMatch(JSON.stringify(decisions), /PRIVATE_RATIONALE_SHOULD_NOT_APPEAR/);
  });

  it("returns local docs and partial unavailable GitHub state when the dashboard token is missing", async () => {
    const root = tempRoot();
    writeSoc2Docs(root);
    let fetchCalled = false;

    const dashboard = await buildSoc2DashboardReadiness({
      rootDir: root,
      env: {},
      fetchImpl: (async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      now: new Date("2026-06-27T10:30:00.000Z"),
    });

    assert.equal(fetchCalled, false);
    assert.equal(dashboard.localDocs.status, "available");
    assert.equal(dashboard.config.tokenConfigured, false);
    assert.equal(dashboard.github.issue.status, "unavailable");
    assert.match(dashboard.github.issue.error || "", /SOC2_DASHBOARD_GITHUB_TOKEN/);
    assert.equal(dashboard.overall.counts.controls, 2);
    assert.equal(dashboard.appImpact, APP_IMPACT);
  });

  it("triggers workflow dispatch for the configured repo, workflow, and main ref", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    const result = await dispatchSoc2DashboardResync({
      env: {
        SOC2_DASHBOARD_GITHUB_TOKEN: "token",
        SOC2_DASHBOARD_REPO: "example/SchoolPilot",
        SOC2_DASHBOARD_WORKFLOW: "ci-build.yml",
      },
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(null, { status: 204 });
      }) as typeof fetch,
      now: new Date("2026-06-27T11:00:00.000Z"),
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://api.github.com/repos/example/SchoolPilot/actions/workflows/ci-build.yml/dispatches");
    assert.equal(calls[0]?.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { ref: "main" });
    assert.equal(result.status, "queued");
    assert.equal(result.workflowUrl, "https://github.com/example/SchoolPilot/actions/workflows/ci-build.yml");
  });

  it("enforces super-admin-only access for the SOC 2 routes", async () => {
    process.env.DATABASE_URL ||= "postgres://postgres:test@localhost:5432/schoolpilot_test";
    const { requireSoc2SuperAdmin } = await import("../src/routes/admin/soc2.js");
    let statusCode = 200;
    let responseBody: unknown;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(body: unknown) {
        responseBody = body;
        return this;
      },
    } as Response;
    let nextCalled = false;
    const next: NextFunction = () => {
      nextCalled = true;
    };

    requireSoc2SuperAdmin({ authUser: { isSuperAdmin: false } } as Request, res, next);
    assert.equal(statusCode, 403);
    assert.deepEqual(responseBody, { error: "Super admin access required" });
    assert.equal(nextCalled, false);

    requireSoc2SuperAdmin({ authUser: { isSuperAdmin: true } } as Request, res, next);
    assert.equal(nextCalled, true);
  });
});
