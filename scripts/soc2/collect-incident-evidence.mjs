#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_IMPACT = "No user-facing behavior changed";
const PENDING_STATUS = "pending_human_approval";
const DEFAULT_INCIDENT_ID = "SOC2-001-HISTORICAL-CREDENTIAL-EXPOSURE";
const DEFAULT_TITLE = "Historical credential exposure readiness record";

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

function slugify(value) {
  return String(value || "incident")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "incident";
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

function pointer(label, location) {
  return { label, location };
}

export function buildIncidentEvidence({
  rootDir,
  env = process.env,
  now = new Date(),
  incidentId = DEFAULT_INCIDENT_ID,
  title = DEFAULT_TITLE,
} = {}) {
  const resolvedRoot = rootDir || fileURLToPath(new URL("../..", import.meta.url));
  const collectedAt = now.toISOString();
  const repository = env.GITHUB_REPOSITORY || runGit(resolvedRoot, ["config", "--get", "remote.origin.url"], "local");
  const gitRef = env.GITHUB_REF || refName(env) || runGit(resolvedRoot, ["branch", "--show-current"], "local");
  const branch = refName(env) || runGit(resolvedRoot, ["branch", "--show-current"], "local");
  const commitSha = env.GITHUB_SHA || runGit(resolvedRoot, ["rev-parse", "HEAD"], "local");

  const packet = {
    evidenceId: incidentId,
    collectedAt,
    sourceSystem: env.GITHUB_ACTIONS ? "github-actions" : "local",
    controls: ["SP-SEC-003"],
    remediationItems: ["SOC2-001"],
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
    },
    incident: {
      incidentId,
      title,
      category: "credential_exposure",
      status: "evidence_collection_in_progress",
      privateEvidenceLocation: "SchoolPilot-SOC2-Evidence/incidents/",
      publicPacketContents: "Non-sensitive metadata and evidence pointers only.",
      sensitiveDataHandling: "Do not copy secrets, logs, credentials, customer data, student data, or private incident details into this packet.",
    },
    evidencePointers: {
      incidentReport: [
        pointer("Private incident report", "SchoolPilot-SOC2-Evidence/incidents/"),
        pointer("Incident response policy", "docs/WISP.md"),
      ],
      credentialRotation: [
        pointer("Credential rotation evidence", "SchoolPilot-SOC2-Evidence/incidents/credential-rotation/"),
      ],
      logReview: [
        pointer("Security log review evidence", "SchoolPilot-SOC2-Evidence/incidents/log-review/"),
      ],
    },
    exposureAssessment: {
      status: "pending_human_assessment",
      customerDataExposure: "pending_human_assessment",
      studentDataExposure: "pending_human_assessment",
      evidencePointer: "SchoolPilot-SOC2-Evidence/incidents/exposure-assessment/",
    },
    humanDecisions: {
      closure: {
        decisionType: "incident_decision",
        status: PENDING_STATUS,
        approverRole: "Security & Privacy Officer",
        privateEvidenceLocation: "SchoolPilot-SOC2-Evidence/incidents/",
      },
      notification: {
        decisionType: "notification_decision",
        status: PENDING_STATUS,
        approverRole: "Security & Privacy Officer",
        privateEvidenceLocation: "SchoolPilot-SOC2-Evidence/incidents/",
      },
    },
    retention: "Store generated packet as a GitHub Actions artifact and retain final incident decisions in the private SchoolPilot-SOC2-Evidence/incidents/ repository.",
  };

  const validation = validateIncidentEvidence(packet);
  return { packet, validation };
}

export function validateIncidentEvidence(packet) {
  const errors = [];
  const required = [
    ["evidenceId", packet.evidenceId],
    ["collectedAt", packet.collectedAt],
    ["controls", Array.isArray(packet.controls) && packet.controls.includes("SP-SEC-003")],
    ["remediationItems", Array.isArray(packet.remediationItems) && packet.remediationItems.includes("SOC2-001")],
    ["appImpact", packet.appImpact],
    ["git.repository", packet.git?.repository],
    ["git.ref", packet.git?.ref],
    ["git.commitSha", packet.git?.commitSha],
    ["ci.workflow", packet.ci?.workflow],
    ["ci.runId", packet.ci?.runId],
    ["incident.incidentId", packet.incident?.incidentId],
    ["incident.privateEvidenceLocation", packet.incident?.privateEvidenceLocation],
    ["exposureAssessment.status", packet.exposureAssessment?.status],
    ["humanDecisions.closure.status", packet.humanDecisions?.closure?.status],
    ["humanDecisions.notification.status", packet.humanDecisions?.notification?.status],
  ];

  for (const [name, value] of required) {
    if (!value) errors.push(`Missing required incident evidence field: ${name}`);
  }

  if (packet.appImpact !== APP_IMPACT) {
    errors.push("Incident evidence appImpact must remain no-user-facing-change.");
  }
  if (packet.humanDecisions?.closure?.status !== PENDING_STATUS) {
    errors.push("Incident closure must remain pending human approval.");
  }
  if (packet.humanDecisions?.notification?.status !== PENDING_STATUS) {
    errors.push("Notification decision must remain pending human approval.");
  }
  if (!packet.evidencePointers?.credentialRotation?.length) {
    errors.push("Incident evidence must include credential rotation evidence pointers.");
  }
  if (!packet.evidencePointers?.logReview?.length) {
    errors.push("Incident evidence must include log review evidence pointers.");
  }

  return { status: errors.length > 0 ? "fail" : "pass", errors };
}

export function formatIncidentEvidenceMarkdown(packet, validation) {
  const pointerLines = Object.entries(packet.evidencePointers || {})
    .flatMap(([group, pointers]) => (pointers || []).map((item) => `- ${group}: ${item.label} (${item.location})`))
    .join("\n") || "- No evidence pointers.";
  const validationLines = validation.errors.length
    ? validation.errors.map((error) => `- ERROR: ${error}`).join("\n")
    : "- No blocking validation errors.";

  return `# SOC 2 Incident Evidence

- Evidence ID: ${packet.evidenceId}
- Incident ID: ${packet.incident.incidentId}
- Title: ${packet.incident.title}
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

## Sensitive Data Boundary

${packet.incident.sensitiveDataHandling}

## Evidence Pointers

${pointerLines}

## Exposure Assessment

- Status: ${packet.exposureAssessment.status}
- Customer data exposure: ${packet.exposureAssessment.customerDataExposure}
- Student data exposure: ${packet.exposureAssessment.studentDataExposure}
- Evidence pointer: ${packet.exposureAssessment.evidencePointer}

## Human Decisions

- Incident closure: ${packet.humanDecisions.closure.status}
- Notification decision: ${packet.humanDecisions.notification.status}
- Approver role: ${packet.humanDecisions.closure.approverRole}

## Validation

${validationLines}

## Retention

${packet.retention}
`;
}

export function writeIncidentEvidence({ packet, validation }, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const baseName = `${slugify(packet.incident.incidentId)}-incident-evidence`;
  const jsonPath = path.join(outputDir, `${baseName}.json`);
  const mdPath = path.join(outputDir, `${baseName}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify({ ...packet, qualityGate: validation }, null, 2)}\n`);
  fs.writeFileSync(mdPath, formatIncidentEvidenceMarkdown(packet, validation));
  return { jsonPath, mdPath };
}

export function runCli() {
  const rootDir = path.resolve(argValue("root-dir", fileURLToPath(new URL("../..", import.meta.url))));
  const outputDir = path.resolve(rootDir, argValue("output-dir", path.join(process.env.SOC2_EVIDENCE_DIR || "soc2-evidence", "incidents")));
  const incidentId = argValue("incident-id", DEFAULT_INCIDENT_ID);
  const title = argValue("title", DEFAULT_TITLE);
  const evidence = buildIncidentEvidence({ rootDir, incidentId, title });
  const { jsonPath, mdPath } = writeIncidentEvidence(evidence, outputDir);

  console.log(`[soc2-incident] wrote ${jsonPath}`);
  console.log(`[soc2-incident] wrote ${mdPath}`);

  for (const error of evidence.validation.errors) {
    console.error(`[soc2-incident] error: ${error}`);
  }
  if (evidence.validation.errors.length > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
