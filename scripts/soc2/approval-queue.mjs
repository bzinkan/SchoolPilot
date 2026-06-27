#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildRiskAcceptanceDrafts,
  parseMarkdownTable,
} from "./check-governance-evidence.mjs";

const APP_IMPACT = "No user-facing behavior changed";
const PENDING_STATUS = "pending_human_approval";
const ALLOWED_DECISIONS = ["approved", "not_approved"];
const ALLOWED_RECOMMENDATIONS = new Set(["approved", "not_approved", "manual_review"]);

const CONTROL_BY_REMEDIATION_ID = {
  "SOC2-001": "SP-SEC-003",
  "SOC2-002": "SP-CONF-002",
  "SOC2-003": "SP-SEC-001",
  "SOC2-004": "SP-SEC-004",
  "SOC2-005": "SP-SEC-002",
  "SOC2-006": "SP-CONF-001",
  "SOC2-007": "SP-SEC-004",
  "SOC2-008": "SP-SEC-004",
  "SOC2-009": "SP-CONF-001",
};

const PRIVATE_SUBDIR_BY_DECISION_TYPE = {
  risk_acceptance: "risk-acceptances",
  production_deployment_approval: "deployments",
  privileged_access_review: "access-reviews",
  incident_decision: "incidents",
  notification_decision: "incidents",
  vendor_dpa_confirmation: "vendors",
  vendor_review_confirmation: "vendors",
  monitoring_review: "monitoring/reviews",
  restore_drill_approval: "backups/restore-tests",
  founder_training_attestation: "training",
  ai_data_flow_review: "ai/reviews",
  tenant_isolation_review: "tenant-isolation",
  human_approval: "approvals",
};

function argValue(name, fallback = "") {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env[name.toUpperCase().replace(/-/g, "_")] || fallback;
}

function readText(rootDir, relativePath) {
  const fullPath = path.join(rootDir, relativePath);
  if (!fs.existsSync(fullPath)) return "";
  return fs.readFileSync(fullPath, "utf8");
}

function readJson(rootDir, relativePath) {
  return JSON.parse(readText(rootDir, relativePath));
}

function parseJsonFile(fullPath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(fullPath, "utf8"));
  } catch {
    return fallback;
  }
}

function slugify(value) {
  return String(value || "approval")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "approval";
}

function runUrl(env) {
  if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) {
    return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  }
  return "";
}

function decisionTypeForEvidence(name, location = "") {
  const text = `${name} ${location}`.toLowerCase();
  if (/risk[- ]acceptance|risk acceptance|mfa rollout decision/.test(text)) return "risk_acceptance";
  if (/production deployment|deploy approval|deployment approval/.test(text)) return "production_deployment_approval";
  if (/privileged|access review|role assignment|role approval/.test(text)) return "privileged_access_review";
  if (/notification decision/.test(text)) return "notification_decision";
  if (/incident/.test(text)) return "incident_decision";
  if (/\bdpa\b/.test(text)) return "vendor_dpa_confirmation";
  if (/vendor|subprocessor/.test(text)) return "vendor_review_confirmation";
  if (/monitoring|alert review|health and error/.test(text)) return "monitoring_review";
  if (/restore|backup/.test(text)) return "restore_drill_approval";
  if (/training|attestation/.test(text)) return "founder_training_attestation";
  if (/\bai\b|data-flow|data flow/.test(text)) return "ai_data_flow_review";
  if (/tenant isolation|\brls\b|row-level security/.test(text)) return "tenant_isolation_review";
  return "human_approval";
}

function sourceIdForHumanApproval(controlId, evidenceName) {
  return `${controlId}:${evidenceName}`;
}

function makeApprovalId(parts) {
  return `APPROVAL-${parts.map(slugify).filter(Boolean).join("-")}`.toUpperCase();
}

function pointer(label, location) {
  return {
    label,
    location: location || "not_available",
  };
}

function normalizeRecommendation(value = "manual_review") {
  return ALLOWED_RECOMMENDATIONS.has(value) ? value : "manual_review";
}

function loadPrivateReadiness(rootDir, privateReadinessFile = "") {
  if (!privateReadinessFile) return null;
  const resolvedPath = path.resolve(rootDir, privateReadinessFile);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Private evidence readiness file does not exist: ${resolvedPath}`);
  }
  const readiness = parseJsonFile(resolvedPath, null);
  if (!readiness || !Array.isArray(readiness.decisions) || !Array.isArray(readiness.evidenceChecks)) {
    throw new Error(`Private evidence readiness file is invalid: ${resolvedPath}`);
  }
  return readiness;
}

function expirationDateIsExpired(expiresAt, now) {
  if (!expiresAt) return false;
  const expiration = /^\d{4}-\d{2}-\d{2}$/.test(String(expiresAt))
    ? new Date(`${expiresAt}T23:59:59.999Z`)
    : new Date(expiresAt);
  if (Number.isNaN(expiration.getTime())) return false;
  return expiration.getTime() < now.getTime();
}

function readinessGapFromCheck(item, check) {
  return {
    approvalId: item.approvalId,
    controlId: item.controlId,
    decisionType: item.decisionType,
    sourceId: item.sourceId,
    status: "not_ready",
    reason: "Required private evidence is missing.",
    missingEvidence: check.missingEvidence || [],
    requiredEvidence: check.requiredEvidence || [],
    recommendedAction: "Add the missing private evidence, rerun the SOC 2 approval queue, then approve or reject.",
    appImpact: APP_IMPACT,
  };
}

function suppressedApprovalFromDecision(item, decision, now) {
  const expired = item.decisionType === "risk_acceptance"
    && decision.decision === "approved"
    && expirationDateIsExpired(decision.expiresAt, now);
  if (expired) return null;

  return {
    approvalId: item.approvalId,
    controlId: item.controlId,
    decisionType: item.decisionType,
    sourceId: item.sourceId,
    decision: decision.decision,
    decidedAt: decision.decidedAt || "",
    expiresAt: decision.expiresAt || null,
    evidencePath: decision.relativePath || "",
    reason: decision.decision === "approved"
      ? "Approval already recorded in private evidence."
      : "Not-approved decision already recorded in private evidence.",
    appImpact: APP_IMPACT,
  };
}

function applyPrivateReadiness(items, readiness, now) {
  if (!readiness) {
    return {
      items,
      readinessGaps: [],
      suppressedApprovals: [],
    };
  }

  const decisionsByApprovalId = new Map((readiness.decisions || []).map((decision) => [decision.approvalId, decision]));
  const checksByApprovalId = new Map((readiness.evidenceChecks || []).map((check) => [check.approvalId, check]));
  const readyItems = [];
  const readinessGaps = [];
  const suppressedApprovals = [];

  for (const item of items) {
    const decision = decisionsByApprovalId.get(item.approvalId);
    if (decision) {
      const suppressed = suppressedApprovalFromDecision(item, decision, now);
      if (suppressed) {
        suppressedApprovals.push(suppressed);
        continue;
      }
    }

    const check = checksByApprovalId.get(item.approvalId);
    if (check && check.status !== "ready") {
      readinessGaps.push(readinessGapFromCheck(item, check));
      continue;
    }

    readyItems.push(item);
  }

  return {
    items: readyItems,
    readinessGaps: readinessGaps.sort((a, b) => a.approvalId.localeCompare(b.approvalId)),
    suppressedApprovals: suppressedApprovals.sort((a, b) => a.approvalId.localeCompare(b.approvalId)),
  };
}

function buildPendingItem({
  approvalId,
  controlId,
  decisionType,
  sourceId,
  recommendedDecision = "manual_review",
  evidencePointers = [],
  generatedAt,
  expiresAt = null,
  approverRole = "",
  owner = "",
}) {
  return {
    approvalId,
    controlId,
    decisionType,
    sourceId,
    status: PENDING_STATUS,
    recommendedDecision: normalizeRecommendation(recommendedDecision),
    allowedDecisions: ALLOWED_DECISIONS,
    evidencePointers,
    generatedAt,
    expiresAt,
    approverRole,
    owner,
    approverName: null,
    decision: null,
    decidedAt: null,
    rationale: "",
    appImpact: APP_IMPACT,
  };
}

function buildGovernanceApprovalItems(governance, generatedAt) {
  const items = [];

  for (const control of Array.isArray(governance.controls) ? governance.controls : []) {
    for (const evidence of control.evidence || []) {
      if (evidence.automation !== "human_approved") continue;

      const sourceId = sourceIdForHumanApproval(control.id, evidence.name);
      const decisionType = decisionTypeForEvidence(evidence.name, evidence.privateEvidenceLocation);
      items.push(buildPendingItem({
        approvalId: makeApprovalId([control.id, evidence.name]),
        controlId: control.id,
        decisionType,
        sourceId,
        evidencePointers: [
          pointer("Governance control", `docs/soc2/governance-controls.json#${control.id}`),
          pointer("Private evidence location", evidence.privateEvidenceLocation),
        ],
        generatedAt,
        expiresAt: decisionType === "risk_acceptance" ? control.nextReviewDue || null : null,
        approverRole: evidence.humanApproverRole || "",
        owner: control.owner || "",
      }));
    }
  }

  return items;
}

function buildRiskApprovalItems(remediationRows, riskPolicy, generatedAt, now) {
  return buildRiskAcceptanceDrafts(remediationRows, riskPolicy, now).map((draft) => buildPendingItem({
    approvalId: makeApprovalId([draft.riskId, "risk-acceptance"]),
    controlId: CONTROL_BY_REMEDIATION_ID[draft.sourceRemediationId] || "risk-acceptance",
    decisionType: "risk_acceptance",
    sourceId: draft.riskId,
    evidencePointers: [
      pointer("Remediation item", draft.sourceRemediationId),
      pointer("Private evidence location", draft.privateEvidenceLocation),
    ],
    generatedAt,
    expiresAt: draft.expirationDate,
    approverRole: draft.approverRole,
    owner: draft.owner,
  }));
}

function collectDeploymentEvidenceFiles(rootDir, evidenceDir) {
  const deploymentsDir = path.join(evidenceDir, "deployments");
  if (!fs.existsSync(deploymentsDir)) return [];

  return fs
    .readdirSync(deploymentsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const fullPath = path.join(deploymentsDir, name);
      const packet = parseJsonFile(fullPath, null);
      if (!packet?.evidenceId) return null;
      return {
        packet,
        jsonPath: path.relative(rootDir, fullPath).replace(/\\/g, "/"),
        markdownPath: path.relative(rootDir, fullPath.replace(/\.json$/i, ".md")).replace(/\\/g, "/"),
      };
    })
    .filter(Boolean);
}

function buildDeploymentApprovalItems(rootDir, evidenceDir, generatedAt) {
  return collectDeploymentEvidenceFiles(rootDir, evidenceDir)
    .filter(({ packet }) => {
      const deployment = packet.deployment || {};
      return deployment.productionDeployDecision !== "not_requested"
        && deployment.deploymentResult !== "not_deployed";
    })
    .map(({ packet, jsonPath, markdownPath }) => buildPendingItem({
    approvalId: makeApprovalId(["SP-SEC-004", packet.evidenceId, "production-deployment"]),
    controlId: "SP-SEC-004",
    decisionType: "production_deployment_approval",
    sourceId: packet.evidenceId,
    evidencePointers: [
      pointer("Deployment evidence JSON", jsonPath),
      pointer("Deployment evidence Markdown", markdownPath),
      pointer("Workflow run", packet.ci?.runUrl || packet.runUrl || "not_available"),
    ],
    generatedAt,
    expiresAt: null,
    approverRole: packet.deployment?.productionApproverRole || "Founder / Engineering owner",
    owner: "Engineering",
  }));
}

function collectIncidentEvidenceFiles(rootDir, evidenceDir) {
  const incidentsDir = path.join(evidenceDir, "incidents");
  if (!fs.existsSync(incidentsDir)) return [];

  return fs
    .readdirSync(incidentsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const fullPath = path.join(incidentsDir, name);
      const packet = parseJsonFile(fullPath, null);
      const incidentId = packet?.incident?.incidentId || packet?.evidenceId;
      if (!incidentId || !Array.isArray(packet?.controls) || !packet.controls.includes("SP-SEC-003")) return null;
      return {
        packet,
        incidentId,
        jsonPath: path.relative(rootDir, fullPath).replace(/\\/g, "/"),
        markdownPath: path.relative(rootDir, fullPath.replace(/\.json$/i, ".md")).replace(/\\/g, "/"),
      };
    })
    .filter(Boolean);
}

function incidentPointers(packet, jsonPath, markdownPath) {
  const pointers = [
    pointer("Incident evidence JSON", jsonPath),
    pointer("Incident evidence Markdown", markdownPath),
    pointer("Private incident evidence location", packet.incident?.privateEvidenceLocation || "SchoolPilot-SOC2-Evidence/incidents/"),
  ];

  for (const item of packet.evidencePointers?.credentialRotation || []) {
    pointers.push(pointer(item.label || "Credential rotation evidence", item.location));
  }
  for (const item of packet.evidencePointers?.logReview || []) {
    pointers.push(pointer(item.label || "Security log review evidence", item.location));
  }
  if (packet.exposureAssessment?.evidencePointer) {
    pointers.push(pointer("Exposure assessment evidence", packet.exposureAssessment.evidencePointer));
  }

  return pointers;
}

function buildIncidentApprovalItems(rootDir, evidenceDir, generatedAt) {
  return collectIncidentEvidenceFiles(rootDir, evidenceDir).flatMap(({ packet, incidentId, jsonPath, markdownPath }) => {
    const controlId = "SP-SEC-003";
    const evidencePointers = incidentPointers(packet, jsonPath, markdownPath);
    const owner = "Security & Privacy Officer";

    return [
      buildPendingItem({
        approvalId: makeApprovalId([controlId, incidentId, "incident-closure"]),
        controlId,
        decisionType: packet.humanDecisions?.closure?.decisionType || "incident_decision",
        sourceId: `${incidentId}:incident-closure`,
        evidencePointers,
        generatedAt,
        expiresAt: null,
        approverRole: packet.humanDecisions?.closure?.approverRole || "Security & Privacy Officer",
        owner,
      }),
      buildPendingItem({
        approvalId: makeApprovalId([controlId, incidentId, "notification-decision"]),
        controlId,
        decisionType: packet.humanDecisions?.notification?.decisionType || "notification_decision",
        sourceId: `${incidentId}:notification-decision`,
        evidencePointers,
        generatedAt,
        expiresAt: null,
        approverRole: packet.humanDecisions?.notification?.approverRole || "Security & Privacy Officer",
        owner,
      }),
    ];
  });
}

function collectTenantIsolationEvidenceFiles(rootDir, evidenceDir) {
  const tenantIsolationDir = path.join(evidenceDir, "tenant-isolation");
  if (!fs.existsSync(tenantIsolationDir)) return [];

  return fs
    .readdirSync(tenantIsolationDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const fullPath = path.join(tenantIsolationDir, name);
      const packet = parseJsonFile(fullPath, null);
      if (!packet?.evidenceId || !Array.isArray(packet?.controls) || !packet.controls.includes("SP-SEC-002")) return null;
      return {
        packet,
        jsonPath: path.relative(rootDir, fullPath).replace(/\\/g, "/"),
        markdownPath: path.relative(rootDir, fullPath.replace(/\.json$/i, ".md")).replace(/\\/g, "/"),
      };
    })
    .filter(Boolean);
}

function tenantIsolationPointers(packet, jsonPath, markdownPath) {
  return [
    pointer("Tenant isolation evidence JSON", jsonPath),
    pointer("Tenant isolation evidence Markdown", markdownPath),
    pointer("Cross-tenant CI artifact", packet.ci?.evidenceArtifacts?.crossTenantTests || "soc2-evidence-cross-tenant"),
    pointer("RLS-enabled CI artifact", packet.ci?.evidenceArtifacts?.rlsEnabledTests || "soc2-evidence-rls-enabled"),
    pointer("Production RLS status export", packet.rls?.productionStatusExport || "pending_private_export"),
    pointer("DB grants and policies export", packet.rls?.dbGrantsAndPoliciesExport || "pending_private_export"),
    pointer("Private evidence location", packet.rls?.privateEvidenceLocation || "SchoolPilot-SOC2-Evidence/tenant-isolation/"),
  ];
}

function buildTenantIsolationApprovalItems(rootDir, evidenceDir, generatedAt) {
  return collectTenantIsolationEvidenceFiles(rootDir, evidenceDir).map(({ packet, jsonPath, markdownPath }) => buildPendingItem({
    approvalId: makeApprovalId(["SP-SEC-002", "tenant-isolation-evidence-review"]),
    controlId: "SP-SEC-002",
    decisionType: packet.humanReview?.decisionType || "tenant_isolation_review",
    sourceId: packet.evidenceId,
    evidencePointers: tenantIsolationPointers(packet, jsonPath, markdownPath),
    generatedAt,
    expiresAt: null,
    approverRole: packet.humanReview?.approverRole || "Engineering",
    owner: "Engineering",
  }));
}

function dedupeItems(items) {
  const byId = new Map();
  for (const item of items) {
    if (!byId.has(item.approvalId)) byId.set(item.approvalId, item);
  }
  return [...byId.values()].sort((a, b) => a.approvalId.localeCompare(b.approvalId));
}

export function buildApprovalQueue({ rootDir, evidenceDir, privateReadinessFile = "", env = process.env, now = new Date() } = {}) {
  const resolvedRoot = rootDir || fileURLToPath(new URL("../..", import.meta.url));
  const resolvedEvidenceDir = evidenceDir || path.join(resolvedRoot, process.env.SOC2_EVIDENCE_DIR || "soc2-evidence");
  const generatedAt = now.toISOString();
  const governance = readJson(resolvedRoot, "docs/soc2/governance-controls.json");
  const riskPolicy = readJson(resolvedRoot, "docs/soc2/risk-acceptance-policy.json");
  const remediationRows = parseMarkdownTable(readText(resolvedRoot, "docs/soc2/remediation-register.md"));
  const privateReadiness = loadPrivateReadiness(resolvedRoot, privateReadinessFile);

  const draftItems = dedupeItems([
    ...buildGovernanceApprovalItems(governance, generatedAt),
    ...buildRiskApprovalItems(remediationRows, riskPolicy, generatedAt, now),
    ...buildIncidentApprovalItems(resolvedRoot, resolvedEvidenceDir, generatedAt),
    ...buildTenantIsolationApprovalItems(resolvedRoot, resolvedEvidenceDir, generatedAt),
    ...buildDeploymentApprovalItems(resolvedRoot, resolvedEvidenceDir, generatedAt),
  ]);
  const { items, readinessGaps, suppressedApprovals } = applyPrivateReadiness(draftItems, privateReadiness, now);

  const errors = validateApprovalQueueItems(items);

  return {
    queueId: `${generatedAt.replace(/[:.]/g, "-")}-soc2-approval-queue`,
    generatedAt,
    sourceSystem: env.GITHUB_ACTIONS ? "github-actions" : "local",
    repository: env.GITHUB_REPOSITORY || "local",
    workflow: env.GITHUB_WORKFLOW || "local",
    runId: env.GITHUB_RUN_ID || "local",
    runAttempt: env.GITHUB_RUN_ATTEMPT || "1",
    runUrl: runUrl(env),
    actor: env.GITHUB_ACTOR || "",
    ref: env.GITHUB_REF || "",
    sha: env.GITHUB_SHA || "",
    appImpact: APP_IMPACT,
    privateEvidenceDefault: "../SchoolPilot-SOC2-Evidence",
    privateReadiness: privateReadiness ? {
      readinessId: privateReadiness.readinessId,
      generatedAt: privateReadiness.generatedAt,
      decisionRecordCount: privateReadiness.decisionRecordCount || privateReadiness.decisions.length,
      evidenceCheckCount: privateReadiness.evidenceCheckCount || privateReadiness.evidenceChecks.length,
      missingEvidenceCheckCount: privateReadiness.missingEvidenceCheckCount || 0,
      qualityGateStatus: privateReadiness.qualityGate?.status || "unknown",
    } : null,
    automationBoundary: governance.humanApprovalBoundary,
    itemCount: items.length,
    items,
    readinessGapCount: readinessGaps.length,
    readinessGaps,
    suppressedApprovalCount: suppressedApprovals.length,
    suppressedApprovals,
    qualityGate: {
      status: errors.length ? "fail" : "pass",
      errors,
    },
  };
}

export function validateApprovalQueueItems(items) {
  const errors = [];
  const seen = new Set();

  for (const item of items) {
    if (!item.approvalId) errors.push("Approval item missing approvalId.");
    if (seen.has(item.approvalId)) errors.push(`Duplicate approvalId ${item.approvalId}.`);
    seen.add(item.approvalId);
    if (!item.controlId) errors.push(`${item.approvalId} missing controlId.`);
    if (!item.decisionType) errors.push(`${item.approvalId} missing decisionType.`);
    if (!item.sourceId) errors.push(`${item.approvalId} missing sourceId.`);
    if (item.status !== PENDING_STATUS) errors.push(`${item.approvalId} must be pending human approval.`);
    if (!ALLOWED_RECOMMENDATIONS.has(item.recommendedDecision)) errors.push(`${item.approvalId} has invalid recommendedDecision.`);
    if (JSON.stringify(item.allowedDecisions) !== JSON.stringify(ALLOWED_DECISIONS)) {
      errors.push(`${item.approvalId} must allow only approved or not_approved.`);
    }
    if (!Array.isArray(item.evidencePointers) || item.evidencePointers.length === 0) {
      errors.push(`${item.approvalId} must include evidence pointers.`);
    }
    if (item.appImpact !== APP_IMPACT) errors.push(`${item.approvalId} must preserve no-user-impact appImpact.`);
    if (item.decisionType === "risk_acceptance" && !item.expiresAt) {
      errors.push(`${item.approvalId} risk acceptance approval must include expiresAt.`);
    }
  }

  return errors;
}

export function formatApprovalQueueMarkdown(queue) {
  const itemLines = queue.items.length
    ? queue.items.map((item) => `- ${item.approvalId}: ${item.decisionType} for ${item.controlId} (${item.status})`).join("\n")
    : "- No pending approvals generated.";
  const gapLines = queue.readinessGaps?.length
    ? queue.readinessGaps.map((gap) => `- ${gap.approvalId}: ${gap.reason} Missing: ${gap.missingEvidence.join(", ") || "not_specified"}`).join("\n")
    : "- No private evidence readiness gaps.";
  const suppressedLines = queue.suppressedApprovals?.length
    ? queue.suppressedApprovals.map((item) => `- ${item.approvalId}: ${item.decision} (${item.evidencePath || "private evidence"})`).join("\n")
    : "- No completed private decisions suppressed.";
  const errorLines = queue.qualityGate.errors.length
    ? queue.qualityGate.errors.map((error) => `- ERROR: ${error}`).join("\n")
    : "- No blocking validation errors.";

  return `# SOC 2 Approval Queue

- Queue ID: ${queue.queueId}
- Generated at: ${queue.generatedAt}
- Status: ${queue.qualityGate.status}
- Repository: ${queue.repository}
- Workflow: ${queue.workflow}
- Run: ${queue.runUrl || `${queue.runId}.${queue.runAttempt}`}
- Actor: ${queue.actor || "local"}
- Ref: ${queue.ref || "local"}
- Commit: ${queue.sha || "local"}
- App impact: ${queue.appImpact}

## Automation Boundary

${queue.automationBoundary}

## Pending Approvals

${itemLines}

## Private Evidence Readiness Gaps

${gapLines}

## Suppressed Completed Decisions

${suppressedLines}

## Decision CLI

Use:

\`\`\`bash
npm run soc2:approval-decision -- --approval-id <approval-id> --decision approved|not_approved --approver "<name>" --rationale "<why>"
\`\`\`

Completed approvals are written to the private evidence repository. Automation drafts this queue but never approves it.

## Quality Gate

${errorLines}
`;
}

export function writeApprovalQueue(queue, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, `${queue.queueId}.json`);
  const mdPath = path.join(outputDir, `${queue.queueId}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(queue, null, 2)}\n`);
  fs.writeFileSync(mdPath, formatApprovalQueueMarkdown(queue));
  return { jsonPath, mdPath };
}

function latestQueueFile(queueDir) {
  if (!fs.existsSync(queueDir)) return "";
  const files = fs
    .readdirSync(queueDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const fullPath = path.join(queueDir, name);
      return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0]?.fullPath || "";
}

function loadApprovalQueue(rootDir, queueFile = "") {
  const resolvedQueueFile = queueFile
    ? path.resolve(rootDir, queueFile)
    : latestQueueFile(path.join(rootDir, process.env.SOC2_EVIDENCE_DIR || "soc2-evidence", "approvals"));

  if (!resolvedQueueFile || !fs.existsSync(resolvedQueueFile)) {
    throw new Error("No approval queue file found. Run npm run soc2:approval-queue first or pass --queue-file.");
  }

  const queue = parseJsonFile(resolvedQueueFile, null);
  if (!queue?.items || !Array.isArray(queue.items)) {
    throw new Error(`Approval queue file is invalid: ${resolvedQueueFile}`);
  }
  return { queue, queueFile: resolvedQueueFile };
}

function validateDecisionInput({ item, decision, approverName, rationale, privateEvidenceDir }) {
  const errors = [];
  if (!item) errors.push("Approval ID was not found in the approval queue.");
  if (!ALLOWED_DECISIONS.includes(decision)) errors.push("Decision must be approved or not_approved.");
  if (!approverName?.trim()) errors.push("Approver is required.");
  if (!rationale?.trim()) errors.push("Rationale is required.");
  if (!privateEvidenceDir || !fs.existsSync(privateEvidenceDir)) {
    errors.push(`Private evidence directory does not exist: ${privateEvidenceDir || "(missing)"}`);
  }
  if (item?.decisionType === "risk_acceptance" && !item.expiresAt) {
    errors.push("Risk acceptance approvals must include an expiration date.");
  }
  return errors;
}

export function formatApprovalDecisionMarkdown(record) {
  const pointerLines = record.evidencePointers.length
    ? record.evidencePointers.map((item) => `- ${item.label}: ${item.location}`).join("\n")
    : "- No evidence pointers.";

  return `# SOC 2 Approval Decision: ${record.approvalId}

- Approval ID: ${record.approvalId}
- Control ID: ${record.controlId}
- Decision type: ${record.decisionType}
- Source ID: ${record.sourceId}
- Decision: ${record.decision}
- Status: ${record.status}
- Approver: ${record.approverName}
- Decided at: ${record.decidedAt}
- Expires at: ${record.expiresAt || "not_applicable"}
- App impact: ${record.appImpact}

## Rationale

${record.rationale}

## Evidence Pointers

${pointerLines}

## Automation Boundary

Automation drafted the approval item. The approver recorded the final decision.
`;
}

export function recordApprovalDecision({
  rootDir,
  approvalId,
  decision,
  approverName,
  rationale,
  privateEvidenceDir,
  queueFile,
  now = new Date(),
} = {}) {
  const resolvedRoot = rootDir || fileURLToPath(new URL("../..", import.meta.url));
  const resolvedPrivateDir = privateEvidenceDir || path.resolve(resolvedRoot, "..", "SchoolPilot-SOC2-Evidence");
  const { queue, queueFile: resolvedQueueFile } = loadApprovalQueue(resolvedRoot, queueFile);
  const item = queue.items.find((entry) => entry.approvalId === approvalId);
  const errors = validateDecisionInput({ item, decision, approverName, rationale, privateEvidenceDir: resolvedPrivateDir });
  if (errors.length) {
    throw new Error(errors.join("\n"));
  }

  const decidedAt = now.toISOString();
  const record = {
    ...item,
    status: decision,
    approverName: approverName.trim(),
    decision,
    decidedAt,
    rationale: rationale.trim(),
    sourceQueueId: queue.queueId,
    sourceQueueFile: path.relative(resolvedRoot, resolvedQueueFile).replace(/\\/g, "/"),
  };

  const subdir = PRIVATE_SUBDIR_BY_DECISION_TYPE[record.decisionType] || PRIVATE_SUBDIR_BY_DECISION_TYPE.human_approval;
  const outputDir = path.join(resolvedPrivateDir, subdir);
  fs.mkdirSync(outputDir, { recursive: true });

  const baseName = `${slugify(record.approvalId)}-${decidedAt.replace(/[:.]/g, "-")}`;
  const jsonPath = path.join(outputDir, `${baseName}.json`);
  const mdPath = path.join(outputDir, `${baseName}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(record, null, 2)}\n`);
  fs.writeFileSync(mdPath, formatApprovalDecisionMarkdown(record));
  return { record, jsonPath, mdPath };
}

function runGenerateCli() {
  const rootDir = path.resolve(argValue("root-dir", fileURLToPath(new URL("../..", import.meta.url))));
  const evidenceDir = path.resolve(rootDir, argValue("evidence-dir", process.env.SOC2_EVIDENCE_DIR || "soc2-evidence"));
  const privateReadinessFile = argValue("private-readiness-file");
  const outputDir = path.resolve(rootDir, argValue("output-dir", path.join(process.env.SOC2_EVIDENCE_DIR || "soc2-evidence", "approvals")));
  const queue = buildApprovalQueue({ rootDir, evidenceDir, privateReadinessFile });
  const { jsonPath, mdPath } = writeApprovalQueue(queue, outputDir);

  console.log(`[soc2-approval] wrote ${jsonPath}`);
  console.log(`[soc2-approval] wrote ${mdPath}`);
  console.log(`[soc2-approval] pending approvals: ${queue.itemCount}`);

  for (const error of queue.qualityGate.errors) {
    console.error(`[soc2-approval] error: ${error}`);
  }
  if (queue.qualityGate.errors.length > 0) process.exit(1);
}

function runDecisionCli() {
  const rootDir = path.resolve(argValue("root-dir", fileURLToPath(new URL("../..", import.meta.url))));
  const privateEvidenceDir = path.resolve(rootDir, argValue("private-dir", process.env.SOC2_PRIVATE_EVIDENCE_DIR || "../SchoolPilot-SOC2-Evidence"));
  const approvalId = argValue("approval-id");
  const decision = argValue("decision");
  const approverName = argValue("approver");
  const rationale = argValue("rationale");
  const queueFile = argValue("queue-file");

  try {
    const { jsonPath, mdPath } = recordApprovalDecision({
      rootDir,
      approvalId,
      decision,
      approverName,
      rationale,
      privateEvidenceDir,
      queueFile,
    });
    console.log(`[soc2-approval] wrote ${jsonPath}`);
    console.log(`[soc2-approval] wrote ${mdPath}`);
  } catch (error) {
    console.error(`[soc2-approval] error: ${error.message}`);
    process.exit(1);
  }
}

export function runCli() {
  const command = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "generate";
  if (command === "decision") {
    runDecisionCli();
    return;
  }
  runGenerateCli();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
