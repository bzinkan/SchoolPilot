#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_IMPACT = "No user-facing behavior changed";
const PENDING_PRIVATE_EXPORT = "pending_private_export";
const PENDING_STATUS = "pending_human_approval";
const EVIDENCE_ID = "TENANT-ISOLATION-EVIDENCE";

const REQUIRED_HASH_FILES = [
  { key: "rlsPolicies", label: "RLS policy source", path: "src/db/rlsPolicies.ts" },
  { key: "tenantContext", label: "Tenant context middleware", path: "src/middleware/tenantContext.ts" },
  { key: "crossTenantTests", label: "Cross-tenant isolation tests", path: "tests/cross-tenant-isolation.test.ts" },
  { key: "rlsPolicyTests", label: "RLS policy tests", path: "tests/rls-policy.test.ts" },
  { key: "rlsTenantContextTests", label: "RLS tenant context tests", path: "tests/rls-tenant-context.test.ts" },
  { key: "rlsCiSetup", label: "RLS CI setup", path: "tests/setup-rls-ci.ts" },
];

function argValue(name, fallback = "") {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env[name.toUpperCase().replace(/-/g, "_")] || fallback;
}

function cliArgValue(name, fallback = "") {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
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

function sha256File(rootDir, relativePath) {
  const fullPath = path.join(rootDir, relativePath);
  if (!fs.existsSync(fullPath)) return null;
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(fullPath));
  return hash.digest("hex");
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

function parseTableList(value = "") {
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .sort();
}

function extractWorkflowRlsTables(rootDir) {
  const workflowPath = path.join(rootDir, ".github", "workflows", "ci-build.yml");
  if (!fs.existsSync(workflowPath)) return "";
  const workflow = fs.readFileSync(workflowPath, "utf8");
  const match = workflow.match(/^\s*RLS_ENABLED_TABLES:\s*(.+)$/m);
  return match?.[1]?.trim().replace(/^["']|["']$/g, "") || "";
}

function resolveRlsAllowlist(rootDir, env, explicitValue = "") {
  if (explicitValue.trim()) {
    return { source: "cli", raw: explicitValue.trim(), tables: parseTableList(explicitValue) };
  }
  if (env.RLS_ENABLED_TABLES?.trim()) {
    return { source: "env", raw: env.RLS_ENABLED_TABLES.trim(), tables: parseTableList(env.RLS_ENABLED_TABLES) };
  }
  const workflowValue = extractWorkflowRlsTables(rootDir);
  return { source: workflowValue ? "ci_workflow" : "missing", raw: workflowValue, tables: parseTableList(workflowValue) };
}

function buildHashes(rootDir) {
  return Object.fromEntries(
    REQUIRED_HASH_FILES.map((entry) => [
      entry.key,
      {
        label: entry.label,
        path: entry.path,
        sha256: sha256File(rootDir, entry.path),
      },
    ]),
  );
}

export function buildTenantIsolationEvidence({
  rootDir,
  env = process.env,
  now = new Date(),
  rlsEnabledTables = "",
} = {}) {
  const resolvedRoot = rootDir || fileURLToPath(new URL("../..", import.meta.url));
  const collectedAt = now.toISOString();
  const repository = env.GITHUB_REPOSITORY || runGit(resolvedRoot, ["config", "--get", "remote.origin.url"], "local");
  const gitRef = env.GITHUB_REF || refName(env) || runGit(resolvedRoot, ["branch", "--show-current"], "local");
  const branch = refName(env) || runGit(resolvedRoot, ["branch", "--show-current"], "local");
  const commitSha = env.GITHUB_SHA || runGit(resolvedRoot, ["rev-parse", "HEAD"], "local");
  const allowlist = resolveRlsAllowlist(resolvedRoot, env, rlsEnabledTables);

  const packet = {
    evidenceId: EVIDENCE_ID,
    collectedAt,
    sourceSystem: env.GITHUB_ACTIONS ? "github-actions" : "local",
    controls: ["SP-SEC-002"],
    remediationItems: ["SOC2-005"],
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
      evidenceArtifacts: {
        crossTenantTests: "soc2-evidence-cross-tenant",
        rlsEnabledTests: "soc2-evidence-rls-enabled",
        tenantIsolationEvidence: "soc2-evidence-tenant-isolation",
      },
    },
    rls: {
      enabled: true,
      gucFlag: "RLS_GUC_ENABLED=true",
      policyName: "tenant_isolation",
      allowlistSource: allowlist.source,
      enabledTables: allowlist.tables,
      enabledTableCount: allowlist.tables.length,
      productionStatusExport: PENDING_PRIVATE_EXPORT,
      dbGrantsAndPoliciesExport: PENDING_PRIVATE_EXPORT,
      privateEvidenceLocation: "SchoolPilot-SOC2-Evidence/tenant-isolation/",
    },
    fileHashes: buildHashes(resolvedRoot),
    humanReview: {
      decisionType: "tenant_isolation_review",
      status: PENDING_STATUS,
      approverRole: "Engineering",
      privateEvidenceLocation: "SchoolPilot-SOC2-Evidence/tenant-isolation/",
    },
    retention: "Store generated packets as GitHub Actions artifacts. Store production RLS exports, DB grants, policies, and final review decisions only in SchoolPilot-SOC2-Evidence/tenant-isolation/.",
  };

  const validation = validateTenantIsolationEvidence(packet);
  return { packet, validation };
}

export function validateTenantIsolationEvidence(packet) {
  const errors = [];
  const required = [
    ["evidenceId", packet.evidenceId],
    ["collectedAt", packet.collectedAt],
    ["controls", Array.isArray(packet.controls) && packet.controls.includes("SP-SEC-002")],
    ["remediationItems", Array.isArray(packet.remediationItems) && packet.remediationItems.includes("SOC2-005")],
    ["appImpact", packet.appImpact],
    ["git.repository", packet.git?.repository],
    ["git.ref", packet.git?.ref],
    ["git.commitSha", packet.git?.commitSha],
    ["ci.workflow", packet.ci?.workflow],
    ["ci.runId", packet.ci?.runId],
    ["rls.enabledTables", Array.isArray(packet.rls?.enabledTables) && packet.rls.enabledTables.length > 0],
    ["rls.productionStatusExport", packet.rls?.productionStatusExport],
    ["rls.dbGrantsAndPoliciesExport", packet.rls?.dbGrantsAndPoliciesExport],
    ["humanReview.status", packet.humanReview?.status],
  ];

  for (const [name, value] of required) {
    if (!value) errors.push(`Missing required tenant isolation evidence field: ${name}`);
  }

  if (packet.appImpact !== APP_IMPACT) {
    errors.push("Tenant isolation evidence appImpact must remain no-user-facing-change.");
  }
  if (packet.rls?.productionStatusExport !== PENDING_PRIVATE_EXPORT) {
    errors.push("Production RLS status export must remain a private evidence pointer.");
  }
  if (packet.rls?.dbGrantsAndPoliciesExport !== PENDING_PRIVATE_EXPORT) {
    errors.push("DB grants/policies export must remain a private evidence pointer.");
  }
  if (packet.humanReview?.status !== PENDING_STATUS) {
    errors.push("Tenant isolation review must remain pending human approval.");
  }
  if (packet.ci?.evidenceArtifacts?.crossTenantTests !== "soc2-evidence-cross-tenant") {
    errors.push("Tenant isolation evidence must reference cross-tenant CI artifacts.");
  }
  if (packet.ci?.evidenceArtifacts?.rlsEnabledTests !== "soc2-evidence-rls-enabled") {
    errors.push("Tenant isolation evidence must reference RLS-enabled CI artifacts.");
  }

  for (const entry of REQUIRED_HASH_FILES) {
    if (!packet.fileHashes?.[entry.key]?.sha256) {
      errors.push(`Missing required file hash: ${entry.path}`);
    }
  }

  return { status: errors.length > 0 ? "fail" : "pass", errors };
}

export function formatTenantIsolationEvidenceMarkdown(packet, validation) {
  const tableLines = packet.rls.enabledTables.length
    ? packet.rls.enabledTables.map((table) => `- ${table}`).join("\n")
    : "- No RLS-enabled tables captured.";
  const hashLines = Object.values(packet.fileHashes)
    .map((item) => `- ${item.label}: \`${item.sha256 || "missing"}\` (${item.path})`)
    .join("\n");
  const validationLines = validation.errors.length
    ? validation.errors.map((error) => `- ERROR: ${error}`).join("\n")
    : "- No blocking validation errors.";

  return `# SOC 2 Tenant Isolation Evidence

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

## CI Evidence

- Cross-tenant tests: ${packet.ci.evidenceArtifacts.crossTenantTests}
- RLS-enabled tests: ${packet.ci.evidenceArtifacts.rlsEnabledTests}
- Tenant isolation evidence: ${packet.ci.evidenceArtifacts.tenantIsolationEvidence}

## RLS Configuration

- GUC flag: ${packet.rls.gucFlag}
- Policy name: ${packet.rls.policyName}
- Allowlist source: ${packet.rls.allowlistSource}
- Enabled table count: ${packet.rls.enabledTableCount}

${tableLines}

## Production Evidence Pointers

- Production RLS status export: ${packet.rls.productionStatusExport}
- DB grants and policies export: ${packet.rls.dbGrantsAndPoliciesExport}
- Private evidence location: ${packet.rls.privateEvidenceLocation}

## Source Hashes

${hashLines}

## Human Review

- Decision type: ${packet.humanReview.decisionType}
- Status: ${packet.humanReview.status}
- Approver role: ${packet.humanReview.approverRole}
- Private evidence location: ${packet.humanReview.privateEvidenceLocation}

## Validation

${validationLines}

## Retention

${packet.retention}
`;
}

export function writeTenantIsolationEvidence({ packet, validation }, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "tenant-isolation-evidence.json");
  const mdPath = path.join(outputDir, "tenant-isolation-evidence.md");
  fs.writeFileSync(jsonPath, `${JSON.stringify({ ...packet, qualityGate: validation }, null, 2)}\n`);
  fs.writeFileSync(mdPath, formatTenantIsolationEvidenceMarkdown(packet, validation));
  return { jsonPath, mdPath };
}

export function runCli() {
  const rootDir = path.resolve(argValue("root-dir", fileURLToPath(new URL("../..", import.meta.url))));
  const outputDir = path.resolve(rootDir, argValue("output-dir", path.join(process.env.SOC2_EVIDENCE_DIR || "soc2-evidence", "tenant-isolation")));
  const rlsEnabledTables = cliArgValue("rls-enabled-tables", "");
  const evidence = buildTenantIsolationEvidence({ rootDir, rlsEnabledTables });
  const { jsonPath, mdPath } = writeTenantIsolationEvidence(evidence, outputDir);

  console.log(`[soc2-tenant-isolation] wrote ${jsonPath}`);
  console.log(`[soc2-tenant-isolation] wrote ${mdPath}`);

  for (const error of evidence.validation.errors) {
    console.error(`[soc2-tenant-isolation] error: ${error}`);
  }
  if (evidence.validation.errors.length > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
