#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REQUIRED_HASH_FILES = [
  { key: "backendPackageLock", label: "Backend package lock", path: "package-lock.json" },
  { key: "frontendPackageLock", label: "Frontend package lock", path: "schoolpilot-app/package-lock.json" },
  { key: "dockerfile", label: "Dockerfile", path: "Dockerfile" },
  { key: "deployScript", label: "Deploy script", path: "scripts/deploy.sh" },
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

function sha256File(rootDir, relativePath) {
  const fullPath = path.join(rootDir, relativePath);
  if (!fs.existsSync(fullPath)) return null;
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(fullPath));
  return hash.digest("hex");
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function readEventPayload(env) {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) return {};
  return parseJson(fs.readFileSync(eventPath, "utf8"), {}) || {};
}

function refName(env) {
  if (env.GITHUB_HEAD_REF) return env.GITHUB_HEAD_REF;
  if (env.GITHUB_REF_NAME) return env.GITHUB_REF_NAME;
  if (env.GITHUB_REF?.startsWith("refs/heads/")) return env.GITHUB_REF.slice("refs/heads/".length);
  if (env.GITHUB_REF?.startsWith("refs/pull/")) return env.GITHUB_REF;
  return "";
}

function extractPullRequest(env, event) {
  if (env.PR_NUMBER || env.PR_URL) {
    return {
      number: env.PR_NUMBER || "",
      url: env.PR_URL || "",
    };
  }

  const pr = event.pull_request;
  if (pr) {
    return {
      number: pr.number ? String(pr.number) : "",
      url: pr.html_url || "",
    };
  }

  if (event.number && env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY) {
    return {
      number: String(event.number),
      url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/pull/${event.number}`,
    };
  }

  return { number: "", url: "" };
}

function normalizeJobResults(value) {
  const parsed = typeof value === "string" ? parseJson(value, {}) : value;
  if (!parsed || typeof parsed !== "object") return [];

  return Object.entries(parsed).map(([job, data]) => ({
    job,
    result: data?.result || "unknown",
  }));
}

function buildRunUrl(env) {
  if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) {
    return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  }
  return "";
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

export function buildDeploymentEvidence({ rootDir, env = process.env, now = new Date() } = {}) {
  const resolvedRoot = rootDir || fileURLToPath(new URL("../..", import.meta.url));
  const event = readEventPayload(env);
  const pr = extractPullRequest(env, event);
  const collectedAt = now.toISOString();
  const safeTimestamp = collectedAt.replace(/[:.]/g, "-");
  const repository = env.GITHUB_REPOSITORY || runGit(resolvedRoot, ["config", "--get", "remote.origin.url"], "local");
  const gitRef = env.GITHUB_REF || refName(env) || runGit(resolvedRoot, ["branch", "--show-current"], "local");
  const branch = refName(env) || runGit(resolvedRoot, ["branch", "--show-current"], "local");
  const commitSha = env.GITHUB_SHA || runGit(resolvedRoot, ["rev-parse", "HEAD"], "local");
  const jobResults = normalizeJobResults(env.CI_JOB_RESULTS);

  const packet = {
    evidenceId: `${safeTimestamp}-shadow-deployment-evidence`,
    collectedAt,
    sourceSystem: env.GITHUB_ACTIONS ? "github-actions" : "local",
    controls: ["SP-SEC-004"],
    appImpact: "No user-facing behavior changed",
    git: {
      repository,
      ref: gitRef,
      branch,
      commitSha,
      actor: env.GITHUB_ACTOR || "",
      eventName: env.GITHUB_EVENT_NAME || "",
      pullRequest: pr,
    },
    ci: {
      workflow: env.GITHUB_WORKFLOW || "local",
      runId: env.GITHUB_RUN_ID || "local",
      runAttempt: env.GITHUB_RUN_ATTEMPT || "1",
      runUrl: buildRunUrl(env),
      currentJob: env.GITHUB_JOB || "local",
      currentJobStatus: env.JOB_STATUS || "unknown",
      jobResults,
      evidenceArtifacts: {
        backendBuild: "soc2-evidence-backend",
        frontendBuild: "soc2-evidence-frontend",
        crossTenantTests: "soc2-evidence-cross-tenant",
        rlsEnabledTests: "soc2-evidence-rls-enabled",
        deploymentEvidence: "soc2-evidence-deployment",
      },
    },
    fileHashes: buildHashes(resolvedRoot),
    deployment: {
      shadowMode: true,
      awsCredentialsRequired: false,
      awsActionsPerformed: false,
      imageDigest: env.DEPLOYED_IMAGE_DIGEST || "pending/not_deployed",
      productionDeployDecision: "not_requested",
      productionApprovalStatus: "pending_human_approval",
      productionApproverRole: "Founder / Engineering owner",
      deploymentEnvironment: "production",
      deploymentResult: "not_deployed",
    },
    retention: "Store in GitHub Actions artifacts and the private SchoolPilot-SOC2-Evidence/deployments/ repository. Do not commit generated packets.",
  };

  const validation = validateDeploymentEvidence(packet);
  return { packet, validation };
}

export function validateDeploymentEvidence(packet) {
  const errors = [];
  const required = [
    ["evidenceId", packet.evidenceId],
    ["collectedAt", packet.collectedAt],
    ["controls", Array.isArray(packet.controls) && packet.controls.includes("SP-SEC-004")],
    ["appImpact", packet.appImpact],
    ["git.repository", packet.git?.repository],
    ["git.ref", packet.git?.ref],
    ["git.commitSha", packet.git?.commitSha],
    ["ci.workflow", packet.ci?.workflow],
    ["ci.runId", packet.ci?.runId],
    ["deployment.imageDigest", packet.deployment?.imageDigest],
    ["deployment.productionDeployDecision", packet.deployment?.productionDeployDecision],
    ["deployment.productionApprovalStatus", packet.deployment?.productionApprovalStatus],
  ];

  for (const [name, value] of required) {
    if (!value) errors.push(`Missing required deployment evidence field: ${name}`);
  }

  if (packet.appImpact !== "No user-facing behavior changed") {
    errors.push("Deployment evidence appImpact must remain no-user-facing-change.");
  }
  if (packet.deployment?.productionDeployDecision !== "not_requested") {
    errors.push("Shadow deployment evidence must not request production deployment.");
  }
  if (packet.deployment?.productionApprovalStatus !== "pending_human_approval") {
    errors.push("Production approval must remain pending human approval.");
  }
  if (packet.deployment?.awsActionsPerformed !== false) {
    errors.push("Shadow deployment evidence must not perform AWS actions.");
  }

  for (const entry of REQUIRED_HASH_FILES) {
    if (!packet.fileHashes?.[entry.key]?.sha256) {
      errors.push(`Missing required file hash: ${entry.path}`);
    }
  }

  return { status: errors.length > 0 ? "fail" : "pass", errors };
}

export function formatDeploymentEvidenceMarkdown(packet, validation) {
  const hashLines = Object.values(packet.fileHashes)
    .map((item) => `- ${item.label}: \`${item.sha256 || "missing"}\` (${item.path})`)
    .join("\n");
  const jobLines = packet.ci.jobResults.length
    ? packet.ci.jobResults.map((job) => `- ${job.job}: ${job.result}`).join("\n")
    : "- No aggregate CI job results were available in this context.";
  const validationLines = validation.errors.length
    ? validation.errors.map((error) => `- ERROR: ${error}`).join("\n")
    : "- No blocking validation errors.";

  return `# SOC 2 Shadow Deployment Evidence

- Evidence ID: ${packet.evidenceId}
- Collected at: ${packet.collectedAt}
- Status: ${validation.status}
- Controls: ${packet.controls.join(", ")}
- App impact: ${packet.appImpact}

## Source

- Repository: ${packet.git.repository}
- Branch: ${packet.git.branch}
- Ref: ${packet.git.ref}
- Commit SHA: ${packet.git.commitSha}
- Actor: ${packet.git.actor || "local"}
- Event: ${packet.git.eventName || "local"}
- Pull request: ${packet.git.pullRequest.url || packet.git.pullRequest.number || "not_available"}

## CI Evidence

- Workflow: ${packet.ci.workflow}
- Run: ${packet.ci.runUrl || `${packet.ci.runId}.${packet.ci.runAttempt}`}
- Current job: ${packet.ci.currentJob}
- Current job status: ${packet.ci.currentJobStatus}

${jobLines}

## Evidence Artifact References

- Backend build: ${packet.ci.evidenceArtifacts.backendBuild}
- Frontend build: ${packet.ci.evidenceArtifacts.frontendBuild}
- Cross-tenant tests: ${packet.ci.evidenceArtifacts.crossTenantTests}
- RLS-enabled tests: ${packet.ci.evidenceArtifacts.rlsEnabledTests}
- Deployment evidence: ${packet.ci.evidenceArtifacts.deploymentEvidence}

## Artifact Hashes

${hashLines}

## Deployment Decision

- Shadow mode: ${packet.deployment.shadowMode}
- AWS credentials required: ${packet.deployment.awsCredentialsRequired}
- AWS actions performed: ${packet.deployment.awsActionsPerformed}
- Image digest: ${packet.deployment.imageDigest}
- Production deploy decision: ${packet.deployment.productionDeployDecision}
- Production approval: ${packet.deployment.productionApprovalStatus}
- Production approver role: ${packet.deployment.productionApproverRole}
- Result: ${packet.deployment.deploymentResult}

## Validation

${validationLines}

## Retention

${packet.retention}
`;
}

export function writeDeploymentEvidence({ packet, validation }, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, `${packet.evidenceId}.json`);
  const mdPath = path.join(outputDir, `${packet.evidenceId}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify({ ...packet, qualityGate: validation }, null, 2)}\n`);
  fs.writeFileSync(mdPath, formatDeploymentEvidenceMarkdown(packet, validation));
  return { jsonPath, mdPath };
}

export function runCli() {
  const rootDir = path.resolve(argValue("root-dir", fileURLToPath(new URL("../..", import.meta.url))));
  const baseEvidenceDir = argValue("output-dir", path.join(process.env.SOC2_EVIDENCE_DIR || "soc2-evidence", "deployments"));
  const outputDir = path.resolve(rootDir, baseEvidenceDir);
  const evidence = buildDeploymentEvidence({ rootDir });
  const { jsonPath, mdPath } = writeDeploymentEvidence(evidence, outputDir);

  console.log(`[soc2-deployment] wrote ${jsonPath}`);
  console.log(`[soc2-deployment] wrote ${mdPath}`);

  for (const error of evidence.validation.errors) {
    console.error(`[soc2-deployment] error: ${error}`);
  }
  if (evidence.validation.errors.length > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
