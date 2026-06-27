#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_IMPACT = "No user-facing behavior changed";
const DEFAULT_INCIDENT_ID = "SOC2-001-HISTORICAL-CREDENTIAL-EXPOSURE";
const DRAFT_STATUS = "draft_pending_founder_input";
const READY_STATUS = "ready_for_approval";

function argValue(name, fallback = "") {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env[name.toUpperCase().replace(/-/g, "_")] || fallback;
}

function argEnabled(name) {
  return process.argv.includes(`--${name}`);
}

function parseJsonFile(fullPath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(fullPath, "utf8"));
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

function privateEvidenceRelativePath(privateEvidenceDir, fullPath) {
  return path.relative(privateEvidenceDir, fullPath).replace(/\\/g, "/");
}

function assertPrivateEvidenceTarget(rootDir, privateEvidenceDir) {
  if (!fs.existsSync(privateEvidenceDir)) {
    throw new Error(`Private evidence directory does not exist: ${privateEvidenceDir}`);
  }

  const resolvedRoot = path.resolve(rootDir);
  const resolvedPrivate = path.resolve(privateEvidenceDir);
  const relative = path.relative(resolvedRoot, resolvedPrivate);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("Refusing to write private incident evidence inside the public SchoolPilot application repository.");
  }
}

function baseRecord({ incidentId, evidenceType, title, generatedAt }) {
  return {
    evidenceId: `${incidentId}-${evidenceType.toUpperCase().replace(/_/g, "-")}`,
    incidentId,
    title,
    controlId: "SP-SEC-003",
    remediationItem: "SOC2-001",
    evidenceType,
    status: DRAFT_STATUS,
    generatedAt,
    appImpact: APP_IMPACT,
    owner: "Security & Privacy Officer",
    completionInstructions: [
      "Complete all TODO fields with factual evidence.",
      "Do not include secret values, raw credentials, customer data, student data, or unrestricted logs.",
      `Set status to ${READY_STATUS} only after the evidence is complete and reviewed by the founder/security owner.`,
    ],
    sensitiveDataHandling: "Store pointers, screenshots, exports, and conclusions here only when they are appropriate for the private evidence repo. Never paste active secrets or raw student/customer records.",
    founderCompletion: {
      completedBy: "TODO",
      completedAt: "TODO",
      readyForApproval: false,
    },
  };
}

function credentialRotationRecord({ incidentId, generatedAt }) {
  return {
    ...baseRecord({
      incidentId,
      evidenceType: "credential_rotation",
      title: "SOC2-001 credential rotation evidence",
      generatedAt,
    }),
    requiredFields: {
      suspectedExposureSummary: "TODO: describe the historical credential exposure without including secret values.",
      credentialsReviewed: [
        {
          systemOrProvider: "TODO",
          credentialType: "TODO",
          secretValueIncluded: false,
          rotationStatus: "TODO: rotated | not_applicable | pending",
          rotatedAt: "TODO",
          rotationEvidencePointer: "TODO: screenshot/export/ticket path or URL",
        },
      ],
      sessionsOrTokensInvalidated: "TODO",
      rotationConfirmedBy: "TODO",
      rotationConfirmedAt: "TODO",
    },
    checklist: [
      "List every potentially exposed credential by system/provider and type, without the secret value.",
      "Confirm whether each credential was rotated or why rotation was not applicable.",
      "Attach or point to screenshots, provider audit entries, ticket IDs, or commit references.",
      "Confirm stale sessions/tokens were invalidated when relevant.",
    ],
  };
}

function logReviewRecord({ incidentId, generatedAt }) {
  return {
    ...baseRecord({
      incidentId,
      evidenceType: "log_review",
      title: "SOC2-001 security log review evidence",
      generatedAt,
    }),
    requiredFields: {
      reviewWindowStart: "TODO",
      reviewWindowEnd: "TODO",
      logSourcesReviewed: [
        {
          sourceName: "TODO",
          dateRange: "TODO",
          evidencePointer: "TODO: screenshot/export/query/ticket path or URL",
          suspiciousAccessFound: "TODO: yes | no | inconclusive",
        },
      ],
      suspiciousAccessSummary: "TODO",
      reviewerConclusion: "TODO",
      reviewedBy: "TODO",
      reviewedAt: "TODO",
    },
    checklist: [
      "Review provider access logs, GitHub/security logs, cloud logs, deployment logs, and app/security events that are relevant to the exposure.",
      "Record only conclusions and evidence pointers; avoid copying raw sensitive logs unless they are redacted and belong in the private repo.",
      "State whether suspicious access was found, not found, or remains inconclusive.",
    ],
  };
}

function exposureAssessmentRecord({ incidentId, generatedAt }) {
  return {
    ...baseRecord({
      incidentId,
      evidenceType: "exposure_assessment",
      title: "SOC2-001 exposure assessment and notification analysis",
      generatedAt,
    }),
    requiredFields: {
      affectedSystems: ["TODO"],
      affectedSchoolsOrUsers: "TODO",
      customerDataExposure: "TODO: confirmed | not_found | inconclusive",
      studentDataExposure: "TODO: confirmed | not_found | inconclusive",
      dataTypesPotentiallyInvolved: ["TODO"],
      severityAssessment: "TODO: Critical | High | Medium | Low",
      notificationRequired: "TODO: yes | no | pending legal/privacy review",
      notificationRationale: "TODO",
      reviewedAgainst: [
        "docs/WISP.md Section 7.2 notification workflow",
        "docs/WISP.md Section 7.3 severity levels",
      ],
      assessmentCompletedBy: "TODO",
      assessmentCompletedAt: "TODO",
    },
    checklist: [
      "Determine whether customer or student data was exposed, based on the credential rotation and log review evidence.",
      "Classify incident severity using the WISP severity table.",
      "Document whether school/customer notification is required and why.",
      "If notification is required, record the planned communication evidence pointer.",
    ],
  };
}

function recordsForIncident({ incidentId, generatedAt }) {
  return [
    {
      directory: "incidents/credential-rotation",
      baseName: "soc2-001-credential-rotation",
      record: credentialRotationRecord({ incidentId, generatedAt }),
    },
    {
      directory: "incidents/log-review",
      baseName: "soc2-001-log-review",
      record: logReviewRecord({ incidentId, generatedAt }),
    },
    {
      directory: "incidents/exposure-assessment",
      baseName: "soc2-001-exposure-assessment",
      record: exposureAssessmentRecord({ incidentId, generatedAt }),
    },
  ];
}

export function formatIncidentPrivateEvidenceMarkdown(record) {
  const requiredFieldLines = Object.entries(record.requiredFields || {})
    .map(([key, value]) => `- ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
  const checklistLines = (record.checklist || []).map((item) => `- [ ] ${item}`).join("\n");

  return `# ${record.title}

- Evidence ID: ${record.evidenceId}
- Incident ID: ${record.incidentId}
- Control ID: ${record.controlId}
- Remediation item: ${record.remediationItem}
- Evidence type: ${record.evidenceType}
- Status: ${record.status}
- Generated at: ${record.generatedAt}
- App impact: ${record.appImpact}

## Completion Instructions

${record.completionInstructions.map((item) => `- ${item}`).join("\n")}

## Required Fields

${requiredFieldLines}

## Checklist

${checklistLines}

## Founder Completion

- Completed by: ${record.founderCompletion.completedBy}
- Completed at: ${record.founderCompletion.completedAt}
- Ready for approval: ${record.founderCompletion.readyForApproval}

## Sensitive Data Handling

${record.sensitiveDataHandling}
`;
}

function writeRecordPair({ privateEvidenceDir, directory, baseName, record, force = false }) {
  const outputDir = path.join(privateEvidenceDir, directory);
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, `${baseName}.json`);
  const mdPath = path.join(outputDir, `${baseName}.md`);

  const existing = fs.existsSync(jsonPath) ? parseJsonFile(jsonPath, null) : null;
  if (existing && existing.status !== DRAFT_STATUS && !force) {
    throw new Error(`Refusing to overwrite non-draft incident evidence: ${jsonPath}`);
  }
  if (existing && existing.status === DRAFT_STATUS && !force) {
    return {
      evidenceType: existing.evidenceType || record.evidenceType,
      status: existing.status,
      jsonPath,
      markdownPath: mdPath,
      privateJsonPath: privateEvidenceRelativePath(privateEvidenceDir, jsonPath),
      privateMarkdownPath: privateEvidenceRelativePath(privateEvidenceDir, mdPath),
      skipped: true,
    };
  }

  fs.writeFileSync(jsonPath, `${JSON.stringify(record, null, 2)}\n`);
  fs.writeFileSync(mdPath, formatIncidentPrivateEvidenceMarkdown(record));

  return {
    evidenceType: record.evidenceType,
    status: record.status,
    jsonPath,
    markdownPath: mdPath,
    privateJsonPath: privateEvidenceRelativePath(privateEvidenceDir, jsonPath),
    privateMarkdownPath: privateEvidenceRelativePath(privateEvidenceDir, mdPath),
    skipped: false,
  };
}

export function writeIncidentPrivateEvidenceKit({
  rootDir,
  privateEvidenceDir,
  incidentId = DEFAULT_INCIDENT_ID,
  now = new Date(),
  force = false,
} = {}) {
  const resolvedRoot = rootDir || fileURLToPath(new URL("../..", import.meta.url));
  const resolvedPrivateDir = path.resolve(
    resolvedRoot,
    privateEvidenceDir || process.env.SOC2_PRIVATE_EVIDENCE_DIR || "../SchoolPilot-SOC2-Evidence",
  );

  assertPrivateEvidenceTarget(resolvedRoot, resolvedPrivateDir);

  const generatedAt = now.toISOString();
  const outputs = recordsForIncident({ incidentId, generatedAt }).map((definition) => writeRecordPair({
    privateEvidenceDir: resolvedPrivateDir,
    directory: definition.directory,
    baseName: definition.baseName,
    record: definition.record,
    force,
  }));

  return {
    incidentId,
    generatedAt,
    status: DRAFT_STATUS,
    appImpact: APP_IMPACT,
    outputs,
  };
}

function runCli() {
  const rootDir = path.resolve(argValue("root-dir", fileURLToPath(new URL("../..", import.meta.url))));
  const privateEvidenceDir = path.resolve(rootDir, argValue("private-dir", process.env.SOC2_PRIVATE_EVIDENCE_DIR || "../SchoolPilot-SOC2-Evidence"));
  const incidentId = argValue("incident-id", DEFAULT_INCIDENT_ID);
  const force = argEnabled("force");

  try {
    const result = writeIncidentPrivateEvidenceKit({
      rootDir,
      privateEvidenceDir,
      incidentId,
      force,
    });

    for (const output of result.outputs) {
      const verb = output.skipped ? "kept existing draft" : "wrote";
      console.log(`[soc2-incident-private-kit] ${verb} ${output.jsonPath}`);
      console.log(`[soc2-incident-private-kit] ${verb} ${output.markdownPath}`);
    }
    console.log(`[soc2-incident-private-kit] status: ${result.status}`);
  } catch (error) {
    console.error(`[soc2-incident-private-kit] error: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
