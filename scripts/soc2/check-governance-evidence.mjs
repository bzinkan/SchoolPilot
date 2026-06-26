#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_REQUIRED_CONTROLS = [
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

const VALID_STATUSES = new Set(["Planned", "Implementing", "Operating", "Exception", "Ready"]);
const VALID_AUTOMATION_MODES = new Set(["automated", "manual_record", "human_approved"]);
const VALID_RISK_AUTOMATION_STATUSES = new Set(["Draft - pending founder approval", "Accepted", "Rejected", "Expired"]);
const HUMAN_DECISION_RE = /\b(approval|approver|attestation|CPA|DPA|incident decision|notification decision|risk acceptance|sign-off|training)\b/i;
const OVERSTATED_SOC2_RE = /\bSOC\s*2\b[^\n|.]{0,120}\b(certified|certification complete|completed audit|completed report|issued report|type ii report)\b/i;
const NOT_CERTIFIED_RE = /\b(not|not yet|planned|readiness|working toward|roadmap|deferred)\b/i;

const PUBLIC_CLAIM_FILES = [
  "docs/WISP.md",
  "docs/HECVAT-LITE.md",
  "docs/v1-SCHOOLPILOT-PRINCIPAL-IT-REVIEW.md",
  "schoolpilot-app/src/pages/legal/Security.jsx",
  "schoolpilot-app/src/pages/legal/PrivacyPolicy.jsx",
  "schoolpilot-app/src/pages/legal/TermsOfService.jsx",
];

const FORBIDDEN_PUBLIC_PHRASES = [
  /All technical controls a SOC 2 auditor would expect are in place/i,
  /implemented the technical control families a SOC 2 Type II audit would assess/i,
  /implementations below exist today and are continuously enforced/i,
  /SOC 2 controls implemented/i,
];

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

function splitMarkdownRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim().replace(/<br\s*\/?>/gi, " "));
}

export function parseMarkdownTable(markdown) {
  const tableLines = markdown
    .split(/\r?\n/)
    .filter((line) => /^\s*\|/.test(line));

  if (tableLines.length < 3) return [];

  const headers = splitMarkdownRow(tableLines[0]);
  const rows = [];

  for (const line of tableLines.slice(2)) {
    const cells = splitMarkdownRow(line);
    if (cells.length !== headers.length) continue;
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;

    const row = {};
    headers.forEach((header, idx) => {
      row[header] = cells[idx] || "";
    });
    rows.push(row);
  }

  return rows;
}

export function validateGovernanceDocument(doc, requiredControls = DEFAULT_REQUIRED_CONTROLS) {
  const errors = [];
  const warnings = [];
  const pendingHumanApprovals = [];
  const controlsById = new Map();

  if (!doc || typeof doc !== "object") {
    return {
      errors: ["Governance document must be a JSON object."],
      warnings,
      pendingHumanApprovals,
      controlsById,
    };
  }

  if (doc.schemaVersion !== 1) errors.push("governance-controls.json schemaVersion must be 1.");
  if (!doc.evidenceRepository) errors.push("governance-controls.json must name the private evidence repository.");
  if (!doc.humanApprovalBoundary) errors.push("governance-controls.json must document the human approval boundary.");
  if (!Array.isArray(doc.controls)) errors.push("governance-controls.json controls must be an array.");

  for (const control of Array.isArray(doc.controls) ? doc.controls : []) {
    if (!control.id) {
      errors.push("Every control must have an id.");
      continue;
    }
    if (controlsById.has(control.id)) errors.push(`Duplicate control id ${control.id}.`);
    controlsById.set(control.id, control);

    if (!control.owner) errors.push(`${control.id} must have an owner.`);
    if (!VALID_STATUSES.has(control.status)) errors.push(`${control.id} has invalid status ${control.status || "(missing)"}.`);
    if (!control.frequency) errors.push(`${control.id} must have a frequency.`);
    if (!control.nextReviewDue) errors.push(`${control.id} must have a nextReviewDue value.`);
    if (!control.automationImpact) errors.push(`${control.id} must document user/app impact.`);
    if (!Array.isArray(control.evidence) || control.evidence.length === 0) {
      errors.push(`${control.id} must define at least one evidence item.`);
      continue;
    }

    for (const item of control.evidence) {
      const label = `${control.id} evidence item ${item?.name || "(unnamed)"}`;
      if (!item?.name) errors.push(`${label} must have a name.`);
      if (!VALID_AUTOMATION_MODES.has(item?.automation)) errors.push(`${label} has invalid automation mode.`);
      if (!item?.privateEvidenceLocation) errors.push(`${label} must have a private evidence location or artifact pointer.`);

      if (item?.automation === "human_approved") {
        if (!item.humanApproverRole) errors.push(`${label} requires humanApproverRole.`);
        pendingHumanApprovals.push({
          controlId: control.id,
          evidence: item.name,
          approverRole: item.humanApproverRole || "",
          privateEvidenceLocation: item.privateEvidenceLocation || "",
        });
      } else if (HUMAN_DECISION_RE.test(item?.name || "")) {
        warnings.push(`${label} looks human-owned but is marked ${item.automation}.`);
      }
    }
  }

  for (const controlId of requiredControls) {
    if (!controlsById.has(controlId)) errors.push(`Missing governance metadata for ${controlId}.`);
  }

  for (const item of pendingHumanApprovals) {
    warnings.push(`Human approval pending/tracked: ${item.controlId} ${item.evidence}.`);
  }

  return { errors, warnings, pendingHumanApprovals, controlsById };
}

export function validateRiskAcceptancePolicy(policy) {
  const errors = [];
  const warnings = [];

  if (!policy || typeof policy !== "object") {
    return { errors: ["risk-acceptance-policy.json must be a JSON object."], warnings };
  }

  if (policy.schemaVersion !== 1) errors.push("risk-acceptance-policy.json schemaVersion must be 1.");
  if (!policy.owner) errors.push("risk-acceptance-policy.json must define an owner.");
  if (!policy.approverRole) errors.push("risk-acceptance-policy.json must define an approverRole.");
  if (!policy.privateEvidenceLocation) errors.push("risk-acceptance-policy.json must define a privateEvidenceLocation.");
  if (!VALID_RISK_AUTOMATION_STATUSES.has(policy.draftStatus)) errors.push("risk-acceptance-policy.json draftStatus is invalid.");
  if (!Number.isInteger(policy.defaultExpirationDays) || policy.defaultExpirationDays < 1) {
    errors.push("risk-acceptance-policy.json defaultExpirationDays must be a positive integer.");
  }
  if (!Array.isArray(policy.autoDraftPriorities) || policy.autoDraftPriorities.length === 0) {
    errors.push("risk-acceptance-policy.json autoDraftPriorities must be a non-empty array.");
  }
  if (!Array.isArray(policy.autoDraftStatuses) || policy.autoDraftStatuses.length === 0) {
    errors.push("risk-acceptance-policy.json autoDraftStatuses must be a non-empty array.");
  }
  if (!policy.compensatingControlsByArea || typeof policy.compensatingControlsByArea !== "object") {
    warnings.push("risk-acceptance-policy.json has no compensatingControlsByArea map; generated drafts will use a generic control.");
  }

  return { errors, warnings };
}

function addDaysIso(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function slugify(value) {
  return String(value || "risk")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "risk";
}

function isEligibleRisk(row, policy) {
  const priority = row.Priority || "";
  const status = row.Status || "";
  return policy.autoDraftPriorities.includes(priority) && policy.autoDraftStatuses.includes(status);
}

export function buildRiskAcceptanceDrafts(remediationRows, policy, now = new Date()) {
  const expirationDate = addDaysIso(now, policy.defaultExpirationDays || 90);
  const controlsByArea = policy.compensatingControlsByArea || {};

  return remediationRows
    .filter((row) => isEligibleRisk(row, policy))
    .map((row) => {
      const area = row.Area || "General";
      const controls = controlsByArea[area] || ["Document compensating control before approval"];
      return {
        riskId: `RA-${row.ID}`,
        sourceRemediationId: row.ID,
        priority: row.Priority,
        riskLevel: policy.riskLevelByPriority?.[row.Priority] || "Medium",
        area,
        owner: row.Owner || policy.owner,
        approverRole: policy.approverRole,
        status: policy.draftStatus,
        generatedAt: now.toISOString(),
        expirationDate,
        privateEvidenceLocation: policy.privateEvidenceLocation,
        description: row.Gap || "",
        evidenceNeeded: row["Evidence Needed"] || "",
        target: row.Target || "",
        compensatingControls: controls,
        automationNote: "Automation drafted this record from the remediation register. Founder approval is still required before the risk is accepted.",
      };
    });
}

export function evaluateClaims(claimRows, controlsById) {
  const errors = [];
  const warnings = [];

  for (const row of claimRows) {
    const claimId = row["Claim ID"] || "(unknown claim)";
    const claim = row.Claim || "";
    const status = row.Status || "";
    const action = row.Action || "";
    const combined = `${claim} ${status} ${action}`;

    if (OVERSTATED_SOC2_RE.test(combined) && !NOT_CERTIFIED_RE.test(combined)) {
      errors.push(`${claimId} appears to claim completed SOC 2 certification or report without a readiness qualifier.`);
    }

    if (/\b(Not evidenced|Needs remediation|operating evidence needed|Partially supported)\b/i.test(status)) {
      warnings.push(`${claimId} requires evidence follow-up: ${status}.`);
    }

    if (/\bMFA\b/i.test(combined)) {
      const privilegedAccess = controlsById.get("SP-SEC-001");
      if (!privilegedAccess || !["Operating", "Ready"].includes(privilegedAccess.status)) {
        warnings.push(`${claimId} references MFA while SP-SEC-001 is not operating; keep MFA claims partial/deferred.`);
      }
    }

    if (/\bDPA|vendor\b/i.test(claim) && /\bSupported|Ready|Operating\b/i.test(status) && !/\bpartial|not evidenced|needs|private\b/i.test(status)) {
      warnings.push(`${claimId} may need private DPA evidence before being treated as operating.`);
    }
  }

  return { errors, warnings };
}

export function scanPublicClaimFiles(rootDir) {
  const errors = [];
  const warnings = [];

  for (const relativePath of PUBLIC_CLAIM_FILES) {
    const content = readText(rootDir, relativePath);
    if (!content) continue;

    for (const pattern of FORBIDDEN_PUBLIC_PHRASES) {
      if (pattern.test(content)) {
        errors.push(`${relativePath} contains an overstated SOC 2 readiness phrase: ${pattern.source}`);
      }
    }

    const lines = content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (OVERSTATED_SOC2_RE.test(line) && !NOT_CERTIFIED_RE.test(line)) {
        errors.push(`${relativePath}:${idx + 1} appears to claim completed SOC 2 certification/report.`);
      }
    });

    if (/\bMFA required\b/i.test(content) && !/\bin-app MFA\b[^\n.]{0,80}\b(roadmap|deferred|planned|partial)\b/i.test(content)) {
      warnings.push(`${relativePath} says MFA required; confirm it is scoped to production/admin systems or softened.`);
    }
  }

  return { errors, warnings };
}

function summarizeRows(rows, field) {
  const counts = {};
  for (const row of rows) {
    const value = row[field] || "(missing)";
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function countControlStatuses(controls) {
  const counts = {};
  for (const control of controls) counts[control.status] = (counts[control.status] || 0) + 1;
  return counts;
}

function countEvidenceModes(controls) {
  const counts = {};
  for (const control of controls) {
    for (const item of control.evidence || []) {
      counts[item.automation] = (counts[item.automation] || 0) + 1;
    }
  }
  return counts;
}

export function buildGovernanceEvidence({ rootDir, env = process.env } = {}) {
  const resolvedRoot = rootDir || fileURLToPath(new URL("../..", import.meta.url));
  const governance = readJson(resolvedRoot, "docs/soc2/governance-controls.json");
  const riskPolicy = readJson(resolvedRoot, "docs/soc2/risk-acceptance-policy.json");
  const validation = validateGovernanceDocument(governance);
  const riskPolicyValidation = validateRiskAcceptancePolicy(riskPolicy);
  const remediationRows = parseMarkdownTable(readText(resolvedRoot, "docs/soc2/remediation-register.md"));
  const claimRows = parseMarkdownTable(readText(resolvedRoot, "docs/soc2/claim-register.md"));
  const riskAcceptanceDrafts = buildRiskAcceptanceDrafts(remediationRows, riskPolicy);
  const claims = evaluateClaims(claimRows, validation.controlsById);
  const publicClaims = scanPublicClaimFiles(resolvedRoot);

  const errors = [...validation.errors, ...riskPolicyValidation.errors, ...claims.errors, ...publicClaims.errors];
  const warnings = [...validation.warnings, ...riskPolicyValidation.warnings, ...claims.warnings, ...publicClaims.warnings];
  const now = new Date().toISOString();
  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : "";

  return {
    evidenceId: `${now.replace(/[:.]/g, "-")}-soc2-governance`,
    collectedAt: now,
    sourceSystem: env.GITHUB_ACTIONS ? "github-actions" : "local",
    repository: env.GITHUB_REPOSITORY || "local",
    workflow: env.GITHUB_WORKFLOW || "local",
    runId: env.GITHUB_RUN_ID || "local",
    runAttempt: env.GITHUB_RUN_ATTEMPT || "1",
    runUrl,
    actor: env.GITHUB_ACTOR || "",
    ref: env.GITHUB_REF || "",
    sha: env.GITHUB_SHA || "",
    appImpact: "No user-facing app, login, MFA, school IT, teacher, student, or parent workflow changes.",
    humanApprovalBoundary: governance.humanApprovalBoundary,
    controls: {
      total: governance.controls.length,
      byStatus: countControlStatuses(governance.controls),
      evidenceByMode: countEvidenceModes(governance.controls),
      nextReviewDue: governance.controls.map((control) => ({
        controlId: control.id,
        owner: control.owner,
        status: control.status,
        nextReviewDue: control.nextReviewDue,
      })),
    },
    remediation: {
      total: remediationRows.length,
      byPriority: summarizeRows(remediationRows, "Priority"),
      byStatus: summarizeRows(remediationRows, "Status"),
      openBlockers: remediationRows
        .filter((row) => row.Priority === "P0" && !/\b(closed|done|ready)\b/i.test(row.Status || ""))
        .map((row) => ({ id: row.ID, area: row.Area, status: row.Status })),
    },
    riskAcceptance: {
      automationStatus: "drafts_generated_pending_founder_approval",
      policyOwner: riskPolicy.owner,
      approverRole: riskPolicy.approverRole,
      privateEvidenceLocation: riskPolicy.privateEvidenceLocation,
      defaultExpirationDays: riskPolicy.defaultExpirationDays,
      draftCount: riskAcceptanceDrafts.length,
      drafts: riskAcceptanceDrafts.map((draft) => ({
        riskId: draft.riskId,
        sourceRemediationId: draft.sourceRemediationId,
        priority: draft.priority,
        riskLevel: draft.riskLevel,
        area: draft.area,
        owner: draft.owner,
        status: draft.status,
        expirationDate: draft.expirationDate,
      })),
    },
    claims: {
      total: claimRows.length,
      byStatus: summarizeRows(claimRows, "Status"),
    },
    pendingHumanApprovals: validation.pendingHumanApprovals,
    qualityGate: {
      status: errors.length > 0 ? "fail" : "pass",
      errors,
      warnings,
    },
    retention: "Store generated packets in workflow artifacts or the private SchoolPilot-SOC2-Evidence repository. Do not commit generated packets.",
  };
}

export function formatMarkdownPacket(packet) {
  const errorLines = packet.qualityGate.errors.length
    ? packet.qualityGate.errors.map((error) => `- ERROR: ${error}`).join("\n")
    : "- No blocking errors.";
  const warningLines = packet.qualityGate.warnings.length
    ? packet.qualityGate.warnings.map((warning) => `- WARNING: ${warning}`).join("\n")
    : "- No warnings.";
  const approvalLines = packet.pendingHumanApprovals.length
    ? packet.pendingHumanApprovals
        .map((item) => `- ${item.controlId}: ${item.evidence} (${item.approverRole})`)
        .join("\n")
    : "- No human approvals tracked.";
  const riskDraftLines = packet.riskAcceptance.drafts.length
    ? packet.riskAcceptance.drafts
        .map((draft) => `- ${draft.riskId}: ${draft.area} ${draft.riskLevel} risk, expires ${draft.expirationDate}, ${draft.status}`)
        .join("\n")
    : "- No risk acceptance drafts generated.";

  return `# SOC 2 Governance Evidence

- Evidence ID: ${packet.evidenceId}
- Collected at: ${packet.collectedAt}
- Status: ${packet.qualityGate.status}
- Repository: ${packet.repository}
- Workflow: ${packet.workflow}
- Run: ${packet.runUrl || `${packet.runId}.${packet.runAttempt}`}
- Ref: ${packet.ref}
- Commit: ${packet.sha}

## App Impact

${packet.appImpact}

## Control Summary

- Total controls: ${packet.controls.total}
- By status: ${JSON.stringify(packet.controls.byStatus)}
- Evidence modes: ${JSON.stringify(packet.controls.evidenceByMode)}

## Open P0 Remediation Items

${packet.remediation.openBlockers.length
  ? packet.remediation.openBlockers.map((item) => `- ${item.id}: ${item.area} (${item.status})`).join("\n")
  : "- No open P0 blockers in the remediation register."}

## Human Approval Boundary

${packet.humanApprovalBoundary}

## Pending Human Approvals

${approvalLines}

## Risk Acceptance Automation

- Status: ${packet.riskAcceptance.automationStatus}
- Drafts generated: ${packet.riskAcceptance.draftCount}
- Approver role: ${packet.riskAcceptance.approverRole}
- Private location: ${packet.riskAcceptance.privateEvidenceLocation}

${riskDraftLines}

## Quality Gate

${errorLines}

${warningLines}

## Retention

${packet.retention}
`;
}

export function formatRiskAcceptanceDraft(draft) {
  const controls = draft.compensatingControls.length
    ? draft.compensatingControls.map((control) => `| ${control} | ${draft.owner} | ${draft.privateEvidenceLocation} |`).join("\n")
    : `| Document compensating control before approval | ${draft.owner} | ${draft.privateEvidenceLocation} |`;

  return `# Risk Acceptance Draft: ${draft.riskId}

Risk ID: ${draft.riskId}
Source remediation ID: ${draft.sourceRemediationId}
Related control(s):
Owner: ${draft.owner}
Approver: ${draft.approverRole}
Generated date: ${draft.generatedAt.slice(0, 10)}
Expiration date: ${draft.expirationDate}
Status: ${draft.status}

## Risk

- Area: ${draft.area}
- Priority: ${draft.priority}
- Risk level: ${draft.riskLevel}
- Description: ${draft.description}
- Evidence needed: ${draft.evidenceNeeded}
- Target: ${draft.target}

## Compensating Controls

| Control | Owner | Evidence Location |
| --- | --- | --- |
${controls}

## Decision

Decision: Pending founder approval
Rationale:
Conditions:
Review trigger: Expiration date, material incident, customer requirement, or completion of remediation item ${draft.sourceRemediationId}

## Approval

Approver name:
Approver role: ${draft.approverRole}
Approval date:

## Automation Note

${draft.automationNote}
`;
}

export function writeEvidencePacket(packet, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, `${packet.evidenceId}.json`);
  const mdPath = path.join(outputDir, `${packet.evidenceId}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(packet, null, 2)}\n`);
  fs.writeFileSync(mdPath, formatMarkdownPacket(packet));
  return { jsonPath, mdPath };
}

export function writeRiskAcceptanceDrafts(drafts, outputDir) {
  const draftDir = path.join(outputDir, "risk-acceptances");
  fs.mkdirSync(draftDir, { recursive: true });
  const indexPath = path.join(draftDir, "index.json");
  fs.writeFileSync(indexPath, `${JSON.stringify(drafts, null, 2)}\n`);

  const draftPaths = drafts.map((draft) => {
    const draftPath = path.join(draftDir, `${slugify(draft.riskId)}.md`);
    fs.writeFileSync(draftPath, formatRiskAcceptanceDraft(draft));
    return draftPath;
  });

  return { indexPath, draftPaths };
}

export function runCli() {
  const rootDir = path.resolve(argValue("root-dir", fileURLToPath(new URL("../..", import.meta.url))));
  const outputDir = path.resolve(rootDir, argValue("output-dir", process.env.SOC2_EVIDENCE_DIR || "soc2-evidence"));
  const packet = buildGovernanceEvidence({ rootDir });
  const { jsonPath, mdPath } = writeEvidencePacket(packet, outputDir);
  const riskPolicy = readJson(rootDir, "docs/soc2/risk-acceptance-policy.json");
  const remediationRows = parseMarkdownTable(readText(rootDir, "docs/soc2/remediation-register.md"));
  const riskDrafts = buildRiskAcceptanceDrafts(remediationRows, riskPolicy);
  const { indexPath, draftPaths } = writeRiskAcceptanceDrafts(riskDrafts, outputDir);

  for (const warning of packet.qualityGate.warnings) {
    console.warn(`[soc2-governance] warning: ${warning}`);
  }
  for (const error of packet.qualityGate.errors) {
    console.error(`[soc2-governance] error: ${error}`);
  }

  console.log(`[soc2-governance] wrote ${jsonPath}`);
  console.log(`[soc2-governance] wrote ${mdPath}`);
  console.log(`[soc2-governance] wrote ${indexPath}`);
  console.log(`[soc2-governance] wrote ${draftPaths.length} risk acceptance draft(s)`);

  if (packet.qualityGate.errors.length > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
