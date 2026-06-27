#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_IMPACT = "No user-facing behavior changed";
const DRAFT_STATUS = "draft_pending_founder_input";
const READY_STATUS = "ready_for_approval";
const EVIDENCE_ID = "SOC2-002-AI-DATA-FLOW-REVIEW";

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
    throw new Error("Refusing to write private AI evidence inside the public SchoolPilot application repository.");
  }
}

function buildAiReviewRecord({ generatedAt }) {
  return {
    evidenceId: EVIDENCE_ID,
    controlId: "SP-CONF-002",
    remediationItem: "SOC2-002",
    evidenceType: "ai_data_flow_review",
    title: "SOC2-002 AI data-flow and privacy review",
    status: DRAFT_STATUS,
    generatedAt,
    appImpact: APP_IMPACT,
    owner: "Security & Privacy Officer",
    completionInstructions: [
      "Complete all TODO fields with factual AI/privacy review conclusions.",
      "Do not include API keys, prompt bodies, raw logs, transcripts, customer records, student records, or private vendor contract text.",
      `Set status to ${READY_STATUS} only after the founder/security owner verifies the review is complete.`,
    ],
    sensitiveDataHandling: "This private record may contain conclusions and evidence pointers. Do not paste active secrets, raw prompt bodies, raw transcripts, or unredacted student/customer records.",
    requiredFields: {
      providersReviewed: [
        {
          providerName: "Anthropic",
          serviceUse: "TODO: URL classification, optional AI assistant, MailPilot email safety classification as applicable",
          dpaOrContractPointer: "TODO: private vendor/DPA evidence path or not_applicable",
          trainingUseReviewed: "TODO: yes | no | not_applicable",
        },
      ],
      enabledFeaturesReviewed: [
        {
          featureId: "classpilot_url_classification",
          productionStatus: "TODO",
          dataCategories: ["TODO"],
          approvalConclusion: "TODO",
        },
        {
          featureId: "ai_chat_assistant",
          productionStatus: "TODO",
          dataCategories: ["TODO"],
          approvalConclusion: "TODO",
        },
        {
          featureId: "mailpilot_email_safety_classification",
          productionStatus: "TODO",
          dataCategories: ["TODO"],
          approvalConclusion: "TODO",
        },
      ],
      dataCategoriesReviewed: {
        urlStringsAndPageTitles: "TODO",
        staffPromptsAndToolResults: "TODO",
        gmailMessageTextWhenMailPilotEnabled: "TODO",
        excludedOrProhibitedData: "TODO",
      },
      minimizationControlsReviewed: [
        "TODO: disabled-by-default AI chat review",
        "TODO: role/license tool filtering review",
        "TODO: school/user conversation scoping review",
        "TODO: prompt/tool result minimization review",
      ],
      roleAndLicenseScopingReviewed: "TODO",
      auditLoggingReviewed: "TODO",
      publicClaimsReviewed: {
        aiTransparency: "TODO",
        subprocessors: "TODO",
        privacyPolicy: "TODO",
        claimRegister: "TODO",
      },
      residualRisks: ["TODO"],
      reviewConclusion: "TODO: ready_for_approval | needs_changes",
      reviewedBy: "TODO",
      reviewedAt: "TODO",
    },
    checklist: [
      "Confirm active AI providers and compare them to public subprocessors/AI transparency claims.",
      "Confirm each AI feature's production enablement state and data categories.",
      "Confirm sensitive data is minimized before model-bound processing.",
      "Confirm AI chat tools are role/license scoped and mutating actions require user confirmation.",
      "Confirm audit logging evidence exists for AI chat tool requests, denials, executions, and cancellations.",
      "Confirm vendor/DPA evidence exists privately or record the gap.",
      "Record residual risks and whether any public copy needs a later approved update.",
    ],
    founderCompletion: {
      completedBy: "TODO",
      completedAt: "TODO",
      readyForApproval: false,
    },
  };
}

export function formatAiPrivateEvidenceMarkdown(record) {
  const requiredFieldLines = Object.entries(record.requiredFields || {})
    .map(([key, value]) => `- ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
  const checklistLines = (record.checklist || []).map((item) => `- [ ] ${item}`).join("\n");

  return `# ${record.title}

- Evidence ID: ${record.evidenceId}
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

function writeRecordPair({ privateEvidenceDir, record, force = false }) {
  const outputDir = path.join(privateEvidenceDir, "ai", "reviews");
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "soc2-002-ai-data-flow-review.json");
  const mdPath = path.join(outputDir, "soc2-002-ai-data-flow-review.md");

  const existing = fs.existsSync(jsonPath) ? parseJsonFile(jsonPath, null) : null;
  if (existing && existing.status !== DRAFT_STATUS && !force) {
    throw new Error(`Refusing to overwrite non-draft AI evidence: ${jsonPath}`);
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
  fs.writeFileSync(mdPath, formatAiPrivateEvidenceMarkdown(record));

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

export function writeAiPrivateEvidenceKit({
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
  const record = buildAiReviewRecord({ generatedAt });
  const output = writeRecordPair({
    privateEvidenceDir: resolvedPrivateDir,
    record,
    force,
  });

  return {
    evidenceId: EVIDENCE_ID,
    generatedAt,
    status: DRAFT_STATUS,
    appImpact: APP_IMPACT,
    outputs: [output],
  };
}

function runCli() {
  const rootDir = path.resolve(argValue("root-dir", fileURLToPath(new URL("../..", import.meta.url))));
  const privateEvidenceDir = path.resolve(rootDir, argValue("private-dir", process.env.SOC2_PRIVATE_EVIDENCE_DIR || "../SchoolPilot-SOC2-Evidence"));
  const force = argEnabled("force");

  try {
    const result = writeAiPrivateEvidenceKit({
      rootDir,
      privateEvidenceDir,
      force,
    });

    for (const output of result.outputs) {
      const verb = output.skipped ? "kept existing draft" : "wrote";
      console.log(`[soc2-ai-private-kit] ${verb} ${output.jsonPath}`);
      console.log(`[soc2-ai-private-kit] ${verb} ${output.markdownPath}`);
    }
    console.log(`[soc2-ai-private-kit] status: ${result.status}`);
  } catch (error) {
    console.error(`[soc2-ai-private-kit] error: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
