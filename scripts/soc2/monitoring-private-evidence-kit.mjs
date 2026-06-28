#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_IMPACT = "No user-facing behavior changed";
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
    throw new Error("Refusing to write private monitoring evidence inside the public SchoolPilot application repository.");
  }
}

function reviewPeriod(now) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return {
    reviewMonth: start.toISOString().slice(0, 7),
    reviewPeriodStart: start.toISOString().slice(0, 10),
    reviewPeriodEnd: end.toISOString().slice(0, 10),
  };
}

function buildMonitoringReviewRecord({ generatedAt, period }) {
  return {
    evidenceId: "SOC2-MONTHLY-MONITORING-REVIEW",
    approvalId: "APPROVAL-SP-AVL-002-MONTHLY-MONITORING-REVIEW",
    controlId: "SP-AVL-002",
    remediationItem: "SOC2-008",
    evidenceType: "monthly_monitoring_review",
    decisionType: "monitoring_review",
    title: "Monthly production monitoring review",
    status: DRAFT_STATUS,
    generatedAt,
    reviewMonth: period.reviewMonth,
    reviewPeriodStart: period.reviewPeriodStart,
    reviewPeriodEnd: period.reviewPeriodEnd,
    appImpact: APP_IMPACT,
    owner: "Engineering Lead",
    completionInstructions: [
      "Complete all TODO fields with factual monthly monitoring conclusions.",
      "Use pointers to private logs or dashboards; do not paste production logs, stack traces, secrets, student data, or customer data.",
      `Set status to ${READY_STATUS} only after the review is complete and ready for approval.`,
    ],
    requiredFields: {
      serviceHealthReviewed: "TODO: healthy | degraded | unhealthy with pointer",
      appHealthEndpointReviewed: "TODO: reviewed health endpoint status and timestamp",
      alertDeliveryReviewed: "TODO: email/Telegram/Sentry/monitoring channels reviewed",
      openMonitoringIssues: [
        {
          issue: "TODO or none",
          owner: "TODO",
          followUp: "TODO",
          dueDate: "TODO",
        },
      ],
      ciAndScanStatusReviewed: "TODO: GitHub Actions, CodeQL, secret scanning, dependency/container scan reviewed",
      incidentsOrEscalations: "TODO: none | list private evidence pointers",
      reviewerConclusion: "TODO: ready_for_approval | needs_changes",
      reviewedBy: "TODO",
      reviewedAt: "TODO",
    },
    checklist: [
      "Review production health endpoint status.",
      "Review Super Admin monitoring dashboard status, degraded reasons, and recent error summary.",
      "Review latest main CI workflow status.",
      "Review CodeQL, secret scanning, and dependency/container scanning status.",
      "Review alert delivery health and any failed alert attempts.",
      "Record follow-ups for unresolved monitoring issues.",
    ],
    founderCompletion: {
      completedBy: "TODO",
      completedAt: "TODO",
      readyForApproval: false,
    },
    sensitiveDataHandling: "This private record may contain conclusions and private evidence pointers. Do not paste production logs, stack traces, credentials, tokens, customer records, or student records.",
  };
}

function buildAlertReviewRecord({ generatedAt, period }) {
  return {
    evidenceId: "SOC2-MONTHLY-ALERT-REVIEW",
    approvalId: "APPROVAL-SP-SEC-003-MONTHLY-ALERT-REVIEW-DECISION",
    controlId: "SP-SEC-003",
    remediationItem: "SOC2-008",
    evidenceType: "monthly_alert_review",
    decisionType: "monitoring_review",
    title: "Monthly security alert review",
    status: DRAFT_STATUS,
    generatedAt,
    reviewMonth: period.reviewMonth,
    reviewPeriodStart: period.reviewPeriodStart,
    reviewPeriodEnd: period.reviewPeriodEnd,
    appImpact: APP_IMPACT,
    owner: "Security & Privacy Officer",
    completionInstructions: [
      "Complete all TODO fields with factual security alert review conclusions.",
      "Use pointers to private security_events records or dashboards; do not paste raw alert bodies, secrets, student data, or customer data.",
      `Set status to ${READY_STATUS} only after the alert review is complete and ready for approval.`,
    ],
    requiredFields: {
      securityEventsReviewed: "TODO: yes | no with private evidence pointer",
      openSecurityEvents: [
        {
          eventIdOrPointer: "TODO or none",
          severity: "TODO",
          status: "TODO open | investigating | resolved | false_positive",
          owner: "TODO",
          followUp: "TODO",
        },
      ],
      alertRulesReviewed: [
        "failed_auth_spike",
        "bulk_student_write",
        "off_hours_admin_burst",
        "cross_school_access",
      ],
      alertDeliveryReviewed: "TODO",
      incidentEscalationDecision: "TODO: none_required | incident_opened with pointer",
      reviewerConclusion: "TODO: ready_for_approval | needs_changes",
      reviewedBy: "TODO",
      reviewedAt: "TODO",
    },
    checklist: [
      "Review open and recently resolved security_events.",
      "Confirm critical/high events were investigated or escalated.",
      "Confirm false positives have resolution notes.",
      "Confirm alert delivery path is operating.",
      "Record whether any security event requires incident response evidence.",
      "Record follow-ups and owners for unresolved alerts.",
    ],
    founderCompletion: {
      completedBy: "TODO",
      completedAt: "TODO",
      readyForApproval: false,
    },
    sensitiveDataHandling: "This private record may contain alert review conclusions and pointers. Do not paste raw alert bodies, credentials, tokens, customer records, or student records.",
  };
}

export function formatMonitoringPrivateEvidenceMarkdown(record) {
  const requiredFieldLines = Object.entries(record.requiredFields || {})
    .map(([key, value]) => `- ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
  const checklistLines = (record.checklist || []).map((item) => `- [ ] ${item}`).join("\n");

  return `# ${record.title}

- Evidence ID: ${record.evidenceId}
- Approval ID: ${record.approvalId}
- Control ID: ${record.controlId}
- Remediation item: ${record.remediationItem}
- Evidence type: ${record.evidenceType}
- Decision type: ${record.decisionType}
- Status: ${record.status}
- Generated at: ${record.generatedAt}
- Review month: ${record.reviewMonth}
- Review period: ${record.reviewPeriodStart} through ${record.reviewPeriodEnd}
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

function writeRecordPair({ privateEvidenceDir, relativeBasePath, record, force = false }) {
  const jsonPath = path.join(privateEvidenceDir, `${relativeBasePath}.json`);
  const mdPath = path.join(privateEvidenceDir, `${relativeBasePath}.md`);
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });

  const existing = fs.existsSync(jsonPath) ? parseJsonFile(jsonPath, null) : null;
  if (existing && existing.status !== DRAFT_STATUS && !force) {
    throw new Error(`Refusing to overwrite non-draft monitoring evidence: ${jsonPath}`);
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
  fs.writeFileSync(mdPath, formatMonitoringPrivateEvidenceMarkdown(record));

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

export function writeMonitoringPrivateEvidenceKit({
  rootDir,
  privateEvidenceDir,
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
  const period = reviewPeriod(now);
  const outputs = [
    writeRecordPair({
      privateEvidenceDir: resolvedPrivateDir,
      relativeBasePath: path.join("monitoring", "reviews", "soc2-monthly-monitoring-review"),
      record: buildMonitoringReviewRecord({ generatedAt, period }),
      force,
    }),
    writeRecordPair({
      privateEvidenceDir: resolvedPrivateDir,
      relativeBasePath: path.join("security-events", "reviews", "soc2-monthly-alert-review"),
      record: buildAlertReviewRecord({ generatedAt, period }),
      force,
    }),
  ];

  return {
    evidenceId: "SOC2-MONTHLY-MONITORING-PRIVATE-EVIDENCE-KIT",
    generatedAt,
    status: DRAFT_STATUS,
    appImpact: APP_IMPACT,
    outputs,
  };
}

function runCli() {
  const rootDir = path.resolve(argValue("root-dir", fileURLToPath(new URL("../..", import.meta.url))));
  const privateEvidenceDir = path.resolve(rootDir, argValue("private-dir", process.env.SOC2_PRIVATE_EVIDENCE_DIR || "../SchoolPilot-SOC2-Evidence"));
  const force = argEnabled("force");

  try {
    const result = writeMonitoringPrivateEvidenceKit({
      rootDir,
      privateEvidenceDir,
      force,
    });

    for (const output of result.outputs) {
      const verb = output.skipped ? "kept existing draft" : "wrote";
      console.log(`[soc2-monitoring-private-kit] ${verb} ${output.jsonPath}`);
      console.log(`[soc2-monitoring-private-kit] ${verb} ${output.markdownPath}`);
    }
    console.log(`[soc2-monitoring-private-kit] status: ${result.status}`);
  } catch (error) {
    console.error(`[soc2-monitoring-private-kit] error: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
