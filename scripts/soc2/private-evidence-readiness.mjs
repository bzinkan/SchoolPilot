#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_IMPACT = "No user-facing behavior changed";
const PRIVATE_REPO_NAME = "SchoolPilot-SOC2-Evidence";
const SOC2_001_INCIDENT_ID = "SOC2-001-HISTORICAL-CREDENTIAL-EXPOSURE";
const SOC2_002_AI_EVIDENCE_TYPE = "ai_data_flow_review";
const READY_STATUS = "ready_for_approval";
const ALLOWED_DECISIONS = new Set(["approved", "not_approved"]);

function argValue(name, fallback = "") {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env[name.toUpperCase().replace(/-/g, "_")] || fallback;
}

function readText(fullPath) {
  return fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf8") : "";
}

function readJson(fullPath) {
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function parseJsonFile(fullPath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(fullPath, "utf8"));
  } catch {
    return fallback;
  }
}

function sha256File(fullPath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(fullPath));
  return hash.digest("hex");
}

function slugify(value) {
  return String(value || "approval")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "approval";
}

function makeApprovalId(parts) {
  return `APPROVAL-${parts.map(slugify).filter(Boolean).join("-")}`.toUpperCase();
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

function evidenceLocationMatches(location = "") {
  return [...String(location).matchAll(/SchoolPilot-SOC2-Evidence[\\/]+([^\s,;)]+)/g)]
    .map((match) => match[1].replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
}

function publicPrivatePath(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return normalized ? `${PRIVATE_REPO_NAME}/${normalized}` : PRIVATE_REPO_NAME;
}

function relativePrivatePath(privateEvidenceDir, fullPath) {
  return path.relative(privateEvidenceDir, fullPath).replace(/\\/g, "/");
}

function publicPathForFile(privateEvidenceDir, fullPath) {
  return publicPrivatePath(relativePrivatePath(privateEvidenceDir, fullPath));
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function isMeaningfulEvidenceFile(fullPath) {
  const stat = fs.statSync(fullPath);
  return path.basename(fullPath) !== ".gitkeep" && stat.size > 0;
}

function meaningfulEvidenceFiles(dir) {
  return walkFiles(dir).filter(isMeaningfulEvidenceFile);
}

function summarizeEvidenceLocation(privateEvidenceDir, label, location) {
  const relativePaths = evidenceLocationMatches(location);
  const relativePath = relativePaths[0] || "";
  const fullPath = relativePath ? path.join(privateEvidenceDir, relativePath) : "";
  const files = fullPath ? meaningfulEvidenceFiles(fullPath) : [];

  return {
    label,
    location,
    relativePath: relativePath ? publicPrivatePath(relativePath) : "not_available",
    present: files.length > 0,
    fileCount: files.length,
    fileHashes: files.map((file) => ({
      path: publicPathForFile(privateEvidenceDir, file),
      sha256: sha256File(file),
    })),
  };
}

function summarizeReadyIncidentEvidence(privateEvidenceDir, label, location, evidenceType) {
  const relativePaths = evidenceLocationMatches(location);
  const relativePath = relativePaths[0] || "";
  const fullPath = relativePath ? path.join(privateEvidenceDir, relativePath) : "";
  const files = fullPath ? meaningfulEvidenceFiles(fullPath) : [];
  const jsonRecords = files
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({
      file,
      record: parseJsonFile(file, null),
    }))
    .filter(({ record }) => record?.incidentId === SOC2_001_INCIDENT_ID && record?.evidenceType === evidenceType);
  const readyRecords = jsonRecords.filter(({ record }) => record.status === READY_STATUS);
  const latestStatus = jsonRecords.at(-1)?.record?.status || (files.length ? "present_but_not_ready" : "missing");

  return {
    label,
    location,
    relativePath: relativePath ? publicPrivatePath(relativePath) : "not_available",
    present: readyRecords.length > 0,
    readinessStatus: readyRecords.length > 0 ? READY_STATUS : latestStatus,
    fileCount: files.length,
    readyFileCount: readyRecords.length,
    fileHashes: files.map((file) => ({
      path: publicPathForFile(privateEvidenceDir, file),
      sha256: sha256File(file),
    })),
  };
}

function summarizeReadyAiReviewEvidence(privateEvidenceDir, label, location) {
  const relativePaths = evidenceLocationMatches(location);
  const relativePath = relativePaths[0] || "";
  const fullPath = relativePath ? path.join(privateEvidenceDir, relativePath) : "";
  const files = fullPath ? meaningfulEvidenceFiles(fullPath) : [];
  const jsonRecords = files
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({
      file,
      record: parseJsonFile(file, null),
    }))
    .filter(({ record }) => record?.controlId === "SP-CONF-002"
      && record?.remediationItem === "SOC2-002"
      && record?.evidenceType === SOC2_002_AI_EVIDENCE_TYPE);
  const readyRecords = jsonRecords.filter(({ record }) => record.status === READY_STATUS);
  const latestStatus = jsonRecords.at(-1)?.record?.status || (files.length ? "present_but_not_ready" : "missing");

  return {
    label,
    location,
    relativePath: relativePath ? publicPrivatePath(relativePath) : "not_available",
    present: readyRecords.length > 0,
    readinessStatus: readyRecords.length > 0 ? READY_STATUS : latestStatus,
    fileCount: files.length,
    readyFileCount: readyRecords.length,
    fileHashes: files.map((file) => ({
      path: publicPathForFile(privateEvidenceDir, file),
      sha256: sha256File(file),
    })),
  };
}

function buildEvidenceCheck({
  checkId,
  approvalId,
  controlId,
  decisionType,
  sourceId,
  owner = "",
  requiredEvidence,
}) {
  const missingEvidence = requiredEvidence
    .filter((item) => !item.present)
    .map((item) => item.label);

  return {
    checkId,
    approvalId,
    controlId,
    decisionType,
    sourceId,
    owner,
    status: missingEvidence.length ? "missing" : "ready",
    requiredEvidence,
    missingEvidence,
    appImpact: APP_IMPACT,
  };
}

function buildGovernanceEvidenceChecks(rootDir, privateEvidenceDir) {
  const governancePath = path.join(rootDir, "docs", "soc2", "governance-controls.json");
  if (!fs.existsSync(governancePath)) return [];
  const governance = readJson(governancePath);
  const checks = [];

  for (const control of Array.isArray(governance.controls) ? governance.controls : []) {
    for (const evidence of control.evidence || []) {
      if (evidence.automation !== "human_approved") continue;
      const decisionType = decisionTypeForEvidence(evidence.name, evidence.privateEvidenceLocation);
      if (decisionType === "risk_acceptance") continue;
      if (decisionType === "ai_data_flow_review") continue;

      const approvalId = makeApprovalId([control.id, evidence.name]);
      checks.push(buildEvidenceCheck({
        checkId: `${approvalId}-PRIVATE-EVIDENCE`,
        approvalId,
        controlId: control.id,
        decisionType,
        sourceId: `${control.id}:${evidence.name}`,
        owner: control.owner || "",
        requiredEvidence: [
          summarizeEvidenceLocation(
            privateEvidenceDir,
            evidence.name,
            evidence.privateEvidenceLocation || "",
          ),
        ],
      }));
    }
  }

  return checks;
}

function buildAiEvidenceChecks(privateEvidenceDir) {
  return [
    buildEvidenceCheck({
      checkId: "SOC2-002-AI-DATA-FLOW-REVIEW-PRIVATE-EVIDENCE",
      approvalId: "APPROVAL-SP-CONF-002-AI-DATA-FLOW-REVIEW",
      controlId: "SP-CONF-002",
      decisionType: "ai_data_flow_review",
      sourceId: "SP-CONF-002:AI data-flow review",
      owner: "Engineering",
      requiredEvidence: [
        summarizeReadyAiReviewEvidence(
          privateEvidenceDir,
          "AI data-flow review",
          "SchoolPilot-SOC2-Evidence/ai/reviews/",
        ),
      ],
    }),
  ];
}

function buildIncidentEvidenceChecks(privateEvidenceDir) {
  const requiredEvidence = [
    summarizeReadyIncidentEvidence(
      privateEvidenceDir,
      "Credential rotation evidence",
      "SchoolPilot-SOC2-Evidence/incidents/credential-rotation/",
      "credential_rotation",
    ),
    summarizeReadyIncidentEvidence(
      privateEvidenceDir,
      "Security log review evidence",
      "SchoolPilot-SOC2-Evidence/incidents/log-review/",
      "log_review",
    ),
    summarizeReadyIncidentEvidence(
      privateEvidenceDir,
      "Exposure assessment evidence",
      "SchoolPilot-SOC2-Evidence/incidents/exposure-assessment/",
      "exposure_assessment",
    ),
  ];

  const common = {
    controlId: "SP-SEC-003",
    owner: "Security & Privacy Officer",
    requiredEvidence,
  };

  return [
    buildEvidenceCheck({
      ...common,
      checkId: "SOC2-001-HISTORICAL-CREDENTIAL-EXPOSURE-INCIDENT-CLOSURE-PRIVATE-EVIDENCE",
      approvalId: "APPROVAL-SP-SEC-003-SOC2-001-HISTORICAL-CREDENTIAL-EXPOSURE-INCIDENT-CLOSURE",
      decisionType: "incident_decision",
      sourceId: "SOC2-001-HISTORICAL-CREDENTIAL-EXPOSURE:incident-closure",
    }),
    buildEvidenceCheck({
      ...common,
      checkId: "SOC2-001-HISTORICAL-CREDENTIAL-EXPOSURE-NOTIFICATION-DECISION-PRIVATE-EVIDENCE",
      approvalId: "APPROVAL-SP-SEC-003-SOC2-001-HISTORICAL-CREDENTIAL-EXPOSURE-NOTIFICATION-DECISION",
      decisionType: "notification_decision",
      sourceId: "SOC2-001-HISTORICAL-CREDENTIAL-EXPOSURE:notification-decision",
    }),
  ];
}

function buildTenantIsolationEvidenceChecks(privateEvidenceDir) {
  return [
    buildEvidenceCheck({
      checkId: "TENANT-ISOLATION-EVIDENCE-PRIVATE-EVIDENCE",
      approvalId: "APPROVAL-SP-SEC-002-TENANT-ISOLATION-EVIDENCE-REVIEW",
      controlId: "SP-SEC-002",
      decisionType: "tenant_isolation_review",
      sourceId: "TENANT-ISOLATION-EVIDENCE",
      owner: "Engineering",
      requiredEvidence: [
        summarizeEvidenceLocation(
          privateEvidenceDir,
          "Production RLS status export",
          "SchoolPilot-SOC2-Evidence/tenant-isolation/production-rls-export/",
        ),
        summarizeEvidenceLocation(
          privateEvidenceDir,
          "DB grants and policies export",
          "SchoolPilot-SOC2-Evidence/tenant-isolation/db-grants-policies-export/",
        ),
      ],
    }),
  ];
}

function isDecisionRecord(record) {
  return record?.approvalId && ALLOWED_DECISIONS.has(record.decision);
}

function collectDecisionRecords(privateEvidenceDir) {
  const records = [];

  for (const fullPath of walkFiles(privateEvidenceDir).filter((file) => file.endsWith(".json"))) {
    const parsed = parseJsonFile(fullPath, null);
    if (!isDecisionRecord(parsed)) continue;

    const stat = fs.statSync(fullPath);
    records.push({
      approvalId: parsed.approvalId,
      controlId: parsed.controlId || "",
      decisionType: parsed.decisionType || "",
      sourceId: parsed.sourceId || "",
      decision: parsed.decision,
      status: parsed.status || parsed.decision,
      decidedAt: parsed.decidedAt || "",
      expiresAt: parsed.expiresAt || null,
      relativePath: publicPathForFile(privateEvidenceDir, fullPath),
      sha256: sha256File(fullPath),
      mtimeMs: stat.mtimeMs,
    });
  }

  return records.sort((a, b) => {
    const decided = String(a.decidedAt).localeCompare(String(b.decidedAt));
    if (decided !== 0) return decided;
    return a.mtimeMs - b.mtimeMs;
  });
}

function latestDecisionRecords(records) {
  const latest = new Map();

  for (const record of records) {
    latest.set(record.approvalId, {
      approvalId: record.approvalId,
      controlId: record.controlId,
      decisionType: record.decisionType,
      sourceId: record.sourceId,
      decision: record.decision,
      status: record.status,
      decidedAt: record.decidedAt,
      expiresAt: record.expiresAt,
      relativePath: record.relativePath,
      sha256: record.sha256,
    });
  }

  return [...latest.values()].sort((a, b) => a.approvalId.localeCompare(b.approvalId));
}

function validateReadinessPacket(packet) {
  const errors = [];
  if (packet.appImpact !== APP_IMPACT) errors.push("Readiness packet must preserve no-user-impact appImpact.");

  const serialized = JSON.stringify(packet);
  for (const forbidden of ["PRIVATE_CONTRACT_BODY", "PRIVATE_RATIONALE", "SECRET_ACCESS_KEY", "BEGIN PRIVATE KEY"]) {
    if (serialized.includes(forbidden)) errors.push(`Readiness packet contains forbidden private content marker ${forbidden}.`);
  }

  for (const decision of packet.decisions || []) {
    if (!decision.approvalId) errors.push("Decision metadata missing approvalId.");
    if (!ALLOWED_DECISIONS.has(decision.decision)) {
      errors.push(`${decision.approvalId || "decision"} has invalid decision.`);
    }
    if (!decision.relativePath?.startsWith(`${PRIVATE_REPO_NAME}/`)) {
      errors.push(`${decision.approvalId || "decision"} must use a private evidence relative path.`);
    }
    if (!decision.sha256) errors.push(`${decision.approvalId || "decision"} missing file hash.`);
  }

  for (const check of packet.evidenceChecks || []) {
    if (!check.approvalId) errors.push("Evidence check missing approvalId.");
    if (!["ready", "missing"].includes(check.status)) {
      errors.push(`${check.approvalId || "check"} has invalid readiness status.`);
    }
    if (!Array.isArray(check.requiredEvidence) || check.requiredEvidence.length === 0) {
      errors.push(`${check.approvalId || "check"} must include required evidence metadata.`);
    }
  }

  return errors;
}

export function buildPrivateEvidenceReadiness({
  rootDir,
  privateEvidenceDir,
  env = process.env,
  now = new Date(),
} = {}) {
  const resolvedRoot = rootDir || fileURLToPath(new URL("../..", import.meta.url));
  const resolvedPrivateDir = path.resolve(
    resolvedRoot,
    privateEvidenceDir || process.env.SOC2_PRIVATE_EVIDENCE_DIR || "../SchoolPilot-SOC2-Evidence",
  );

  if (!fs.existsSync(resolvedPrivateDir)) {
    throw new Error(`Private evidence directory does not exist: ${resolvedPrivateDir}`);
  }

  const generatedAt = now.toISOString();
  const allDecisionRecords = collectDecisionRecords(resolvedPrivateDir);
  const packet = {
    readinessId: `${generatedAt.replace(/[:.]/g, "-")}-soc2-private-evidence-readiness`,
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
    privateEvidenceRoot: PRIVATE_REPO_NAME,
    decisionRecordCount: allDecisionRecords.length,
    decisions: latestDecisionRecords(allDecisionRecords),
    evidenceChecks: [
      ...buildGovernanceEvidenceChecks(resolvedRoot, resolvedPrivateDir),
      ...buildAiEvidenceChecks(resolvedPrivateDir),
      ...buildIncidentEvidenceChecks(resolvedPrivateDir),
      ...buildTenantIsolationEvidenceChecks(resolvedPrivateDir),
    ].sort((a, b) => a.approvalId.localeCompare(b.approvalId)),
  };

  const errors = validateReadinessPacket(packet);
  return {
    ...packet,
    evidenceCheckCount: packet.evidenceChecks.length,
    missingEvidenceCheckCount: packet.evidenceChecks.filter((check) => check.status === "missing").length,
    qualityGate: {
      status: errors.length ? "fail" : "pass",
      errors,
    },
  };
}

export function formatPrivateEvidenceReadinessMarkdown(packet) {
  const decisionLines = packet.decisions.length
    ? packet.decisions.map((decision) => `- ${decision.approvalId}: ${decision.decision} (${decision.relativePath}, ${decision.sha256})`).join("\n")
    : "- No completed approval decisions found.";
  const checkLines = packet.evidenceChecks.length
    ? packet.evidenceChecks.map((check) => {
      const missing = check.missingEvidence.length ? `; missing: ${check.missingEvidence.join(", ")}` : "";
      return `- ${check.approvalId}: ${check.status}${missing}`;
    }).join("\n")
    : "- No private evidence checks generated.";
  const errorLines = packet.qualityGate.errors.length
    ? packet.qualityGate.errors.map((error) => `- ERROR: ${error}`).join("\n")
    : "- No blocking validation errors.";

  return `# SOC 2 Private Evidence Readiness

- Readiness ID: ${packet.readinessId}
- Generated at: ${packet.generatedAt}
- Status: ${packet.qualityGate.status}
- Repository: ${packet.repository}
- Workflow: ${packet.workflow}
- Run: ${packet.runUrl || `${packet.runId}.${packet.runAttempt}`}
- Actor: ${packet.actor || "local"}
- Ref: ${packet.ref || "local"}
- Commit: ${packet.sha || "local"}
- App impact: ${packet.appImpact}

This packet contains non-sensitive metadata only: approval IDs, decision
statuses, relative private evidence paths, file hashes, and missing/present
checks. It does not copy private evidence contents or approval rationale.

## Completed Decisions

${decisionLines}

## Evidence Checks

${checkLines}

## Quality Gate

${errorLines}
`;
}

export function writePrivateEvidenceReadiness(packet, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, `${packet.readinessId}.json`);
  const mdPath = path.join(outputDir, `${packet.readinessId}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(packet, null, 2)}\n`);
  fs.writeFileSync(mdPath, formatPrivateEvidenceReadinessMarkdown(packet));
  return { jsonPath, mdPath };
}

function runCli() {
  const rootDir = path.resolve(argValue("root-dir", fileURLToPath(new URL("../..", import.meta.url))));
  const privateEvidenceDir = path.resolve(rootDir, argValue("private-dir", process.env.SOC2_PRIVATE_EVIDENCE_DIR || "../SchoolPilot-SOC2-Evidence"));
  const outputDir = path.resolve(rootDir, argValue("output-dir", path.join(process.env.SOC2_EVIDENCE_DIR || "soc2-evidence", "private-readiness")));

  try {
    const packet = buildPrivateEvidenceReadiness({ rootDir, privateEvidenceDir });
    const { jsonPath, mdPath } = writePrivateEvidenceReadiness(packet, outputDir);
    console.log(`[soc2-private-readiness] wrote ${jsonPath}`);
    console.log(`[soc2-private-readiness] wrote ${mdPath}`);
    console.log(`[soc2-private-readiness] completed decisions: ${packet.decisions.length}`);
    console.log(`[soc2-private-readiness] readiness gaps: ${packet.missingEvidenceCheckCount}`);

    for (const error of packet.qualityGate.errors) {
      console.error(`[soc2-private-readiness] error: ${error}`);
    }
    if (packet.qualityGate.errors.length > 0) process.exit(1);
  } catch (error) {
    console.error(`[soc2-private-readiness] error: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
