#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_IMPACT = "No user-facing behavior changed";
const EVIDENCE_ID = "SOC2-003-PRIVILEGED-ACCESS-EVIDENCE";
const PENDING_STATUS = "pending_human_approval";
const MFA_STATUS = "deferred_not_live";

const SOURCE_HASH_FILES = [
  { key: "authRoutes", label: "Authentication routes", path: "src/routes/auth.ts" },
  { key: "requireRole", label: "Role authorization middleware", path: "src/middleware/requireRole.ts" },
  { key: "schoolContext", label: "School context middleware", path: "src/middleware/requireSchoolContext.ts" },
  { key: "sessionIdleTimeout", label: "Privileged session idle timeout", path: "src/middleware/sessionIdleTimeout.ts" },
  { key: "securityMonitor", label: "Security monitor detections", path: "src/services/securityMonitor.ts" },
  { key: "auditService", label: "Audit logging service", path: "src/services/audit.ts" },
  { key: "coreSchema", label: "Users and memberships schema", path: "src/schema/core.ts" },
  { key: "sharedSchema", label: "Audit/security events schema", path: "src/schema/shared.ts" },
];

function argValue(name, fallback = "") {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env[name.toUpperCase().replace(/-/g, "_")] || fallback;
}

function runGit(rootDir, args, fallback = "") {
  try {
    return execFileSync("git", args, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || fallback;
  } catch {
    return fallback;
  }
}

function refName(env) {
  if (env.GITHUB_HEAD_REF) return env.GITHUB_HEAD_REF;
  if (env.GITHUB_REF_NAME) return env.GITHUB_REF_NAME;
  if (env.GITHUB_REF?.startsWith("refs/heads/")) return env.GITHUB_REF.slice("refs/heads/".length);
  if (env.GITHUB_REF?.startsWith("refs/pull/")) return env.GITHUB_REF;
  return "";
}

function buildRunUrl(env) {
  if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) {
    return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  }
  return "";
}

function readText(rootDir, relativePath) {
  const fullPath = path.join(rootDir, relativePath);
  return fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf8") : "";
}

function sha256File(rootDir, relativePath) {
  const fullPath = path.join(rootDir, relativePath);
  if (!fs.existsSync(fullPath)) return null;
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(fullPath));
  return hash.digest("hex");
}

function sourceContains(rootDir, relativePath, pattern) {
  return pattern.test(readText(rootDir, relativePath));
}

function buildSourceHashes(rootDir) {
  return Object.fromEntries(
    SOURCE_HASH_FILES.map((entry) => [
      entry.key,
      {
        label: entry.label,
        path: entry.path,
        sha256: sha256File(rootDir, entry.path),
      },
    ]),
  );
}

function buildRoleTiers() {
  return [
    {
      tierId: "super_admin",
      sourceOfTruth: "users.is_super_admin",
      reviewReason: "Platform-wide administrative access and RLS super-admin bypass paths.",
      privateExportRequired: true,
    },
    {
      tierId: "school_admin",
      sourceOfTruth: "school_memberships.role in admin, school_admin",
      reviewReason: "School-scoped administrative access to student, staff, device, and configuration workflows.",
      privateExportRequired: true,
    },
    {
      tierId: "operational_elevated",
      sourceOfTruth: "school_memberships.role = office_staff",
      reviewReason: "Operational elevated role included for visibility even where capabilities are narrower than admin.",
      privateExportRequired: true,
    },
  ];
}

function buildSafeguards(rootDir) {
  return {
    authenticatedRoutes: sourceContains(rootDir, "src/routes/auth.ts", /req\.session|authenticate|lastLoginAt/) ? "present" : "review_required",
    roleMiddleware: sourceContains(rootDir, "src/middleware/requireRole.ts", /Super admins bypass role checks|inArray\(schoolMemberships\.role/) ? "present" : "review_required",
    schoolContextBinding: sourceContains(rootDir, "src/middleware/requireSchoolContext.ts", /membershipRole|bindTenantContext/) ? "present" : "review_required",
    privilegedIdleTimeout: sourceContains(rootDir, "src/middleware/sessionIdleTimeout.ts", /ELEVATED_ROLES|admin|school_admin|super_admin/) ? "present" : "review_required",
    auditLogTable: sourceContains(rootDir, "src/schema/shared.ts", /auditLogs|userRole|action/) ? "present" : "review_required",
    securityEventMonitor: sourceContains(rootDir, "src/services/securityMonitor.ts", /off_hours_admin|cross_school_access|user_role IN \('admin'/) ? "present" : "review_required",
    userRoleSchema: sourceContains(rootDir, "src/schema/core.ts", /isSuperAdmin|schoolMemberships|role/) ? "present" : "review_required",
  };
}

export function buildPrivilegedAccessEvidence({
  rootDir,
  env = process.env,
  now = new Date(),
} = {}) {
  const resolvedRoot = rootDir || fileURLToPath(new URL("../..", import.meta.url));
  const collectedAt = now.toISOString();
  const repository = env.GITHUB_REPOSITORY || runGit(resolvedRoot, ["config", "--get", "remote.origin.url"], "local");
  const branch = refName(env) || runGit(resolvedRoot, ["branch", "--show-current"], "local");
  const commitSha = env.GITHUB_SHA || runGit(resolvedRoot, ["rev-parse", "HEAD"], "local");

  const packet = {
    evidenceId: EVIDENCE_ID,
    collectedAt,
    sourceSystem: env.GITHUB_ACTIONS ? "github-actions" : "local",
    controls: ["SP-SEC-001"],
    remediationItems: ["SOC2-003"],
    appImpact: APP_IMPACT,
    git: {
      repository,
      ref: env.GITHUB_REF || branch,
      branch,
      commitSha,
      actor: env.GITHUB_ACTOR || "",
      eventName: env.GITHUB_EVENT_NAME || "",
    },
    ci: {
      workflow: env.GITHUB_WORKFLOW || "local",
      runId: env.GITHUB_RUN_ID || "local",
      runAttempt: env.GITHUB_RUN_ATTEMPT || "1",
      runUrl: buildRunUrl(env),
      currentJob: env.GITHUB_JOB || "local",
      currentJobStatus: env.JOB_STATUS || "unknown",
      evidenceArtifact: "soc2-evidence-privileged-access",
    },
    sensitiveDataBoundary: {
      publicPacketContents: "Non-sensitive metadata, source hashes, role-tier definitions, safeguard summaries, and private evidence pointers only.",
      excludedContent: [
        "password hashes",
        "session contents",
        "secret values",
        "raw user exports",
        "customer records",
        "student records",
      ],
    },
    mfa: {
      status: MFA_STATUS,
      userFacingChangeEnabled: false,
      rolloutDecisionApprovalId: "APPROVAL-SP-SEC-001-PRIVILEGED-MFA-ROLLOUT-DECISION",
      privateRiskAcceptanceLocation: "SchoolPilot-SOC2-Evidence/risk-acceptances/",
    },
    privilegedRoleTiers: buildRoleTiers(),
    safeguards: buildSafeguards(resolvedRoot),
    sourceHashes: buildSourceHashes(resolvedRoot),
    privateEvidencePointers: {
      accessReview: "SchoolPilot-SOC2-Evidence/access-reviews/soc2-003-privileged-access-review.json",
      userRoleExport: "SchoolPilot-SOC2-Evidence/access-reviews/exports/",
      mfaDeferralRiskAcceptance: "SchoolPilot-SOC2-Evidence/risk-acceptances/soc2-003-mfa-deferral-risk-acceptance.json",
    },
    humanReviews: [
      {
        approvalId: "APPROVAL-SP-SEC-001-QUARTERLY-PRIVILEGED-ACCESS-REVIEW-PACKET",
        decisionType: "privileged_access_review",
        status: PENDING_STATUS,
        approverRole: "Security & Privacy Officer",
        privateEvidenceLocation: "SchoolPilot-SOC2-Evidence/access-reviews/",
      },
      {
        approvalId: "APPROVAL-SP-SEC-001-PRIVILEGED-MFA-ROLLOUT-DECISION",
        decisionType: "risk_acceptance",
        status: PENDING_STATUS,
        approverRole: "Management",
        privateEvidenceLocation: "SchoolPilot-SOC2-Evidence/risk-acceptances/",
      },
    ],
    retention: "Store generated packets as GitHub Actions artifacts. Store factual user/role exports, access review conclusions, and final decisions only in SchoolPilot-SOC2-Evidence/.",
  };

  const validation = validatePrivilegedAccessEvidence(packet);
  return { packet, validation };
}

export function validatePrivilegedAccessEvidence(packet) {
  const errors = [];
  const required = [
    ["evidenceId", packet.evidenceId],
    ["collectedAt", packet.collectedAt],
    ["controls", Array.isArray(packet.controls) && packet.controls.includes("SP-SEC-001")],
    ["remediationItems", Array.isArray(packet.remediationItems) && packet.remediationItems.includes("SOC2-003")],
    ["appImpact", packet.appImpact],
    ["git.repository", packet.git?.repository],
    ["git.ref", packet.git?.ref],
    ["git.commitSha", packet.git?.commitSha],
    ["ci.workflow", packet.ci?.workflow],
    ["ci.runId", packet.ci?.runId],
    ["mfa.status", packet.mfa?.status],
    ["privilegedRoleTiers", Array.isArray(packet.privilegedRoleTiers) && packet.privilegedRoleTiers.length >= 3],
    ["humanReviews", Array.isArray(packet.humanReviews) && packet.humanReviews.length >= 2],
  ];

  for (const [name, value] of required) {
    if (!value) errors.push(`Missing required privileged access evidence field: ${name}`);
  }
  if (packet.appImpact !== APP_IMPACT) errors.push("Privileged access evidence appImpact must remain no-user-facing-change.");
  if (packet.mfa?.status !== MFA_STATUS) errors.push("Privileged access evidence must mark MFA as deferred_not_live.");
  if (packet.mfa?.userFacingChangeEnabled !== false) errors.push("Privileged access evidence must not enable user-facing MFA changes.");
  for (const review of packet.humanReviews || []) {
    if (review.status !== PENDING_STATUS) errors.push(`${review.approvalId || "human review"} must remain pending human approval.`);
  }
  for (const entry of SOURCE_HASH_FILES) {
    if (!packet.sourceHashes?.[entry.key]?.sha256) errors.push(`Missing required source hash: ${entry.path}`);
  }

  const serialized = JSON.stringify(packet);
  for (const forbidden of [
    "PRIVATE_USER_EXPORT_BODY",
    "PRIVATE_CUSTOMER_DATA",
    "PRIVATE_STUDENT_DATA",
    "PASSWORD_HASH",
    "SESSION_SECRET_VALUE",
    "BEGIN PRIVATE KEY",
  ]) {
    if (serialized.includes(forbidden)) {
      errors.push(`Privileged access evidence contains forbidden sensitive content marker ${forbidden}.`);
    }
  }

  return { status: errors.length ? "fail" : "pass", errors };
}

export function formatPrivilegedAccessEvidenceMarkdown(packet, validation) {
  const roleLines = packet.privilegedRoleTiers
    .map((tier) => `- ${tier.tierId}: ${tier.sourceOfTruth} (${tier.reviewReason})`)
    .join("\n");
  const safeguardLines = Object.entries(packet.safeguards || {})
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n");
  const hashLines = Object.values(packet.sourceHashes || {})
    .map((item) => `- ${item.label}: \`${item.sha256 || "missing"}\` (${item.path})`)
    .join("\n");
  const reviewLines = packet.humanReviews
    .map((item) => `- ${item.approvalId}: ${item.decisionType} (${item.status})`)
    .join("\n");
  const validationLines = validation.errors.length
    ? validation.errors.map((error) => `- ERROR: ${error}`).join("\n")
    : "- No blocking validation errors.";

  return `# SOC 2 Privileged Access Evidence

- Evidence ID: ${packet.evidenceId}
- Collected at: ${packet.collectedAt}
- Status: ${validation.status}
- Controls: ${packet.controls.join(", ")}
- Remediation items: ${packet.remediationItems.join(", ")}
- App impact: ${packet.appImpact}

## Source

- Repository: ${packet.git.repository}
- Branch: ${packet.git.branch}
- Ref: ${packet.git.ref}
- Commit SHA: ${packet.git.commitSha}
- Actor: ${packet.git.actor || "local"}
- Event: ${packet.git.eventName || "local"}
- Workflow: ${packet.ci.workflow}
- Run: ${packet.ci.runUrl || `${packet.ci.runId}.${packet.ci.runAttempt}`}
- Current job: ${packet.ci.currentJob}
- Current job status: ${packet.ci.currentJobStatus}
- Evidence artifact: ${packet.ci.evidenceArtifact}

## MFA Status

- Status: ${packet.mfa.status}
- User-facing change enabled: ${packet.mfa.userFacingChangeEnabled}
- Rollout decision approval ID: ${packet.mfa.rolloutDecisionApprovalId}

## Privileged Role Tiers

${roleLines}

## Safeguards

${safeguardLines}

## Private Evidence Pointers

- Access review: ${packet.privateEvidencePointers.accessReview}
- User/role export: ${packet.privateEvidencePointers.userRoleExport}
- MFA deferral risk acceptance: ${packet.privateEvidencePointers.mfaDeferralRiskAcceptance}

## Human Reviews

${reviewLines}

## Source Hashes

${hashLines}

## Sensitive Data Boundary

${packet.sensitiveDataBoundary.publicPacketContents}

Excluded content: ${packet.sensitiveDataBoundary.excludedContent.join(", ")}.

## Validation

${validationLines}

## Retention

${packet.retention}
`;
}

export function writePrivilegedAccessEvidence({ packet, validation }, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "soc2-003-privileged-access-evidence.json");
  const mdPath = path.join(outputDir, "soc2-003-privileged-access-evidence.md");
  fs.writeFileSync(jsonPath, `${JSON.stringify({ ...packet, qualityGate: validation }, null, 2)}\n`);
  fs.writeFileSync(mdPath, formatPrivilegedAccessEvidenceMarkdown(packet, validation));
  return { jsonPath, mdPath };
}

export function runCli() {
  const rootDir = path.resolve(argValue("root-dir", fileURLToPath(new URL("../..", import.meta.url))));
  const outputDir = path.resolve(rootDir, argValue("output-dir", path.join(process.env.SOC2_EVIDENCE_DIR || "soc2-evidence", "privileged-access")));
  const evidence = buildPrivilegedAccessEvidence({ rootDir });
  const { jsonPath, mdPath } = writePrivilegedAccessEvidence(evidence, outputDir);

  console.log(`[soc2-privileged-access] wrote ${jsonPath}`);
  console.log(`[soc2-privileged-access] wrote ${mdPath}`);

  for (const error of evidence.validation.errors) {
    console.error(`[soc2-privileged-access] error: ${error}`);
  }
  if (evidence.validation.errors.length > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
