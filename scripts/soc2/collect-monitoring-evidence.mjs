#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_IMPACT = "No user-facing behavior changed";
const EVIDENCE_ID = "SOC2-MONTHLY-MONITORING-EVIDENCE";
const PENDING_STATUS = "pending_human_approval";
const REVIEW_REQUIRED = "review_required";

const SOURCE_HASH_FILES = [
  { key: "monitoringDashboard", label: "Monitoring dashboard service", path: "src/services/monitoringDashboard.ts" },
  { key: "errorMonitor", label: "Error monitor service", path: "src/services/errorMonitor.ts" },
  { key: "securityMonitor", label: "Security monitor service", path: "src/services/securityMonitor.ts" },
  { key: "superAdminMonitoringRoutes", label: "Super Admin monitoring routes", path: "src/routes/admin/monitoring.ts" },
  { key: "soc2DashboardRoutes", label: "Super Admin SOC 2 dashboard routes", path: "src/routes/admin/soc2.ts" },
  { key: "sharedSchema", label: "Audit, security event, and error log schema", path: "src/schema/shared.ts" },
  { key: "errorMonitorTests", label: "Monitoring dashboard tests", path: "tests/error-monitor.test.ts" },
  { key: "soc2DashboardTests", label: "SOC 2 dashboard service tests", path: "tests/soc2-dashboard-service.test.ts" },
  { key: "ciWorkflow", label: "CI workflow", path: ".github/workflows/ci-build.yml" },
  { key: "codeqlWorkflow", label: "CodeQL workflow", path: ".github/workflows/codeql.yml" },
  { key: "gitleaksWorkflow", label: "Secret scanning workflow", path: ".github/workflows/gitleaks.yml" },
  { key: "trivyWorkflow", label: "Container/dependency scanning workflow", path: ".github/workflows/trivy.yml" },
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

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function summarizeCiJobResults(env) {
  const parsed = env.CI_JOB_RESULTS ? parseJson(env.CI_JOB_RESULTS, null) : null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];

  return Object.entries(parsed)
    .map(([job, result]) => ({
      job,
      result: typeof result === "object" && result ? String(result.result || result.conclusion || "unknown") : "unknown",
      outcome: typeof result === "object" && result ? String(result.outcome || result.status || "unknown") : "unknown",
    }))
    .sort((a, b) => a.job.localeCompare(b.job));
}

function workflowExists(rootDir, workflow) {
  return fs.existsSync(path.join(rootDir, ".github", "workflows", workflow));
}

function buildScanPointers(rootDir, env) {
  const repo = env.GITHUB_REPOSITORY || "bzinkan/SchoolPilot";
  const server = env.GITHUB_SERVER_URL || "https://github.com";
  return [
    {
      scanType: "code_scanning",
      workflow: "codeql.yml",
      present: workflowExists(rootDir, "codeql.yml"),
      artifactOrUrl: `${server}/${repo}/security/code-scanning`,
    },
    {
      scanType: "secret_scanning",
      workflow: "gitleaks.yml",
      present: workflowExists(rootDir, "gitleaks.yml"),
      artifactOrUrl: `${server}/${repo}/security/secret-scanning`,
    },
    {
      scanType: "dependency_container_scanning",
      workflow: "trivy.yml",
      present: workflowExists(rootDir, "trivy.yml"),
      artifactOrUrl: `${server}/${repo}/actions/workflows/trivy.yml`,
    },
  ];
}

function buildHealthEvidence(env) {
  return {
    endpoint: env.APP_HEALTH_URL || "https://school-pilot.net/health",
    status: env.APP_HEALTH_STATUS || "pending_runtime_review",
    checkedByThisScript: false,
    evidenceBoundary: "Status is recorded as metadata only; response bodies and logs are not copied into SOC 2 public evidence.",
  };
}

function buildMonitoringSafeguards(rootDir) {
  return {
    postgresHealthProbe: sourceContains(rootDir, "src/services/monitoringDashboard.ts", /SELECT 1/) ? "present" : REVIEW_REQUIRED,
    dbPoolHealthProbe: sourceContains(rootDir, "src/services/monitoringDashboard.ts", /pool\.waitingCount/) ? "present" : REVIEW_REQUIRED,
    alertingStatus: sourceContains(rootDir, "src/services/errorMonitor.ts", /getAlertingStatus/) ? "present" : REVIEW_REQUIRED,
    safeErrorSanitization: sourceContains(rootDir, "src/services/errorMonitor.ts", /sanitizeMonitorString/) ? "present" : REVIEW_REQUIRED,
    recentErrorSanitization: sourceContains(rootDir, "src/services/monitoringDashboard.ts", /sanitizeRecentErrorLogForMonitoring/) ? "present" : REVIEW_REQUIRED,
    superAdminOnlyMonitoringRoutes: sourceContains(rootDir, "src/routes/admin/monitoring.ts", /Super admin access required/) ? "present" : REVIEW_REQUIRED,
    soc2DashboardPartialFailure: sourceContains(rootDir, "src/services/soc2Dashboard.ts", /unavailable/) ? "present" : REVIEW_REQUIRED,
  };
}

function buildSecurityEventCoverage(rootDir) {
  const source = readText(rootDir, "src/services/securityMonitor.ts");
  const detections = [
    ["failed_auth_spike", /checkFailedAuthSpike/],
    ["bulk_student_write", /checkBulkStudentOps/],
    ["off_hours_admin_burst", /checkOffHoursAdminBurst/],
    ["cross_school_access", /checkCrossSchoolAccess/],
  ];
  return detections.map(([eventType, pattern]) => ({
    eventType,
    status: pattern.test(source) ? "present" : REVIEW_REQUIRED,
    reviewRequired: true,
  }));
}

function buildPrivateEvidencePointers() {
  return {
    monthlyMonitoringReview: "SchoolPilot-SOC2-Evidence/monitoring/reviews/soc2-monthly-monitoring-review.json",
    monthlyAlertReview: "SchoolPilot-SOC2-Evidence/security-events/reviews/soc2-monthly-alert-review.json",
    monitoringEvidenceFolder: "SchoolPilot-SOC2-Evidence/monitoring/",
    securityEventReviewFolder: "SchoolPilot-SOC2-Evidence/security-events/reviews/",
  };
}

export function buildMonitoringEvidence({
  rootDir,
  env = process.env,
  now = new Date(),
} = {}) {
  const resolvedRoot = rootDir || fileURLToPath(new URL("../..", import.meta.url));
  const collectedAt = now.toISOString();
  const repository = env.GITHUB_REPOSITORY || runGit(resolvedRoot, ["config", "--get", "remote.origin.url"], "local");
  const gitRef = env.GITHUB_REF || refName(env) || runGit(resolvedRoot, ["branch", "--show-current"], "local");
  const branch = refName(env) || runGit(resolvedRoot, ["branch", "--show-current"], "local");
  const commitSha = env.GITHUB_SHA || runGit(resolvedRoot, ["rev-parse", "HEAD"], "local");

  const packet = {
    evidenceId: EVIDENCE_ID,
    collectedAt,
    sourceSystem: env.GITHUB_ACTIONS ? "github-actions" : "local",
    controls: ["SP-AVL-002", "SP-SEC-003"],
    remediationItems: ["SOC2-008"],
    appImpact: APP_IMPACT,
    git: {
      repository,
      ref: gitRef,
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
      evidenceArtifact: "soc2-evidence-monitoring",
      jobResults: summarizeCiJobResults(env),
    },
    sensitiveDataBoundary: {
      publicPacketContents: "Non-sensitive metadata, source hashes, health status labels, scan pointers, and private evidence pointers only.",
      excludedContent: [
        "production logs",
        "stack traces",
        "alert bodies",
        "student records",
        "customer records",
        "credentials",
        "tokens",
        "private approval rationale",
      ],
    },
    sourceHashes: buildSourceHashes(resolvedRoot),
    healthEvidence: buildHealthEvidence(env),
    scanEvidencePointers: buildScanPointers(resolvedRoot, env),
    monitoringSafeguards: buildMonitoringSafeguards(resolvedRoot),
    securityEventCoverage: buildSecurityEventCoverage(resolvedRoot),
    privateEvidencePointers: buildPrivateEvidencePointers(),
    humanReviews: [
      {
        approvalId: "APPROVAL-SP-AVL-002-MONTHLY-MONITORING-REVIEW",
        controlId: "SP-AVL-002",
        decisionType: "monitoring_review",
        status: PENDING_STATUS,
        approverRole: "Engineering Lead",
        privateEvidenceLocation: "SchoolPilot-SOC2-Evidence/monitoring/reviews/",
      },
      {
        approvalId: "APPROVAL-SP-SEC-003-MONTHLY-ALERT-REVIEW-DECISION",
        controlId: "SP-SEC-003",
        decisionType: "monitoring_review",
        status: PENDING_STATUS,
        approverRole: "Security & Privacy Officer",
        privateEvidenceLocation: "SchoolPilot-SOC2-Evidence/security-events/reviews/",
      },
    ],
    retention: "Store generated packets as GitHub Actions artifacts. Store factual monitoring review conclusions, security alert review details, and final decisions only in SchoolPilot-SOC2-Evidence/.",
  };

  const validation = validateMonitoringEvidence(packet);
  return { packet, validation };
}

export function validateMonitoringEvidence(packet) {
  const errors = [];
  const required = [
    ["evidenceId", packet.evidenceId],
    ["collectedAt", packet.collectedAt],
    ["controls", Array.isArray(packet.controls) && packet.controls.includes("SP-AVL-002") && packet.controls.includes("SP-SEC-003")],
    ["remediationItems", Array.isArray(packet.remediationItems) && packet.remediationItems.includes("SOC2-008")],
    ["appImpact", packet.appImpact],
    ["git.repository", packet.git?.repository],
    ["git.ref", packet.git?.ref],
    ["git.commitSha", packet.git?.commitSha],
    ["ci.workflow", packet.ci?.workflow],
    ["ci.runId", packet.ci?.runId],
    ["healthEvidence.status", packet.healthEvidence?.status],
    ["scanEvidencePointers", Array.isArray(packet.scanEvidencePointers) && packet.scanEvidencePointers.length >= 2],
    ["humanReviews", Array.isArray(packet.humanReviews) && packet.humanReviews.length === 2],
  ];

  for (const [name, value] of required) {
    if (!value) errors.push(`Missing required monitoring evidence field: ${name}`);
  }
  if (packet.appImpact !== APP_IMPACT) errors.push("Monitoring evidence appImpact must remain no-user-facing-change.");
  for (const review of packet.humanReviews || []) {
    if (review.status !== PENDING_STATUS) errors.push(`${review.approvalId || "human review"} must remain pending human approval.`);
  }
  for (const entry of SOURCE_HASH_FILES) {
    if (!packet.sourceHashes?.[entry.key]?.sha256) errors.push(`Missing required source hash: ${entry.path}`);
  }

  const serialized = JSON.stringify(packet);
  for (const forbidden of [
    "PRIVATE_LOG_BODY",
    "PRIVATE_ALERT_BODY",
    "PRIVATE_STACK_TRACE",
    "PRIVATE_STUDENT_DATA",
    "PRIVATE_CUSTOMER_DATA",
    "SECRET_ACCESS_KEY",
    "BEGIN PRIVATE KEY",
    "ANTHROPIC_SECRET_VALUE",
    "TOKEN_VALUE_SHOULD_NOT_APPEAR",
  ]) {
    if (serialized.includes(forbidden)) {
      errors.push(`Monitoring evidence contains forbidden sensitive content marker ${forbidden}.`);
    }
  }

  return { status: errors.length > 0 ? "fail" : "pass", errors };
}

export function formatMonitoringEvidenceMarkdown(packet, validation) {
  const hashLines = Object.values(packet.sourceHashes)
    .map((item) => `- ${item.label}: \`${item.sha256 || "missing"}\` (${item.path})`)
    .join("\n");
  const safeguardLines = Object.entries(packet.monitoringSafeguards || {})
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n");
  const securityLines = packet.securityEventCoverage
    .map((item) => `- ${item.eventType}: ${item.status}`)
    .join("\n");
  const scanLines = packet.scanEvidencePointers
    .map((item) => `- ${item.scanType}: ${item.present ? "present" : "missing"} (${item.artifactOrUrl})`)
    .join("\n");
  const jobLines = packet.ci.jobResults.length
    ? packet.ci.jobResults.map((item) => `- ${item.job}: result=${item.result}; outcome=${item.outcome}`).join("\n")
    : "- No upstream CI job results were supplied.";
  const reviewLines = packet.humanReviews
    .map((item) => `- ${item.approvalId}: ${item.controlId} ${item.decisionType} (${item.status})`)
    .join("\n");
  const validationLines = validation.errors.length
    ? validation.errors.map((error) => `- ERROR: ${error}`).join("\n")
    : "- No blocking validation errors.";

  return `# SOC 2 Monthly Monitoring Evidence

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

## Health Evidence

- Endpoint: ${packet.healthEvidence.endpoint}
- Status: ${packet.healthEvidence.status}
- Checked by this script: ${packet.healthEvidence.checkedByThisScript}

## CI Job Results

${jobLines}

## Scan Evidence Pointers

${scanLines}

## Monitoring Safeguards

${safeguardLines}

## Security Event Coverage

${securityLines}

## Private Evidence Pointers

- Monthly monitoring review: ${packet.privateEvidencePointers.monthlyMonitoringReview}
- Monthly alert review: ${packet.privateEvidencePointers.monthlyAlertReview}

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

export function writeMonitoringEvidence({ packet, validation }, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "soc2-monthly-monitoring-evidence.json");
  const mdPath = path.join(outputDir, "soc2-monthly-monitoring-evidence.md");
  fs.writeFileSync(jsonPath, `${JSON.stringify({ ...packet, qualityGate: validation }, null, 2)}\n`);
  fs.writeFileSync(mdPath, formatMonitoringEvidenceMarkdown(packet, validation));
  return { jsonPath, mdPath };
}

export function runCli() {
  const rootDir = path.resolve(argValue("root-dir", fileURLToPath(new URL("../..", import.meta.url))));
  const outputDir = path.resolve(rootDir, argValue("output-dir", path.join(process.env.SOC2_EVIDENCE_DIR || "soc2-evidence", "monitoring")));
  const evidence = buildMonitoringEvidence({ rootDir });
  const { jsonPath, mdPath } = writeMonitoringEvidence(evidence, outputDir);

  console.log(`[soc2-monitoring] wrote ${jsonPath}`);
  console.log(`[soc2-monitoring] wrote ${mdPath}`);

  for (const error of evidence.validation.errors) {
    console.error(`[soc2-monitoring] error: ${error}`);
  }
  if (evidence.validation.errors.length > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
