#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_IMPACT = "No user-facing behavior changed";
const EVIDENCE_ID = "SOC2-002-AI-PRIVACY-EVIDENCE";
const PENDING_STATUS = "pending_human_approval";
const REVIEW_REQUIRED = "review_required";

const SOURCE_HASH_FILES = [
  { key: "chatRoute", label: "AI chat route", path: "src/routes/chat.ts" },
  { key: "chatService", label: "AI chat service", path: "src/services/chatService.ts" },
  { key: "chatTools", label: "AI chat tools", path: "src/services/chatTools.ts" },
  { key: "chatToolExecutor", label: "AI chat tool executor", path: "src/services/chatToolExecutor.ts" },
  { key: "aiClassification", label: "AI classification service", path: "src/services/aiClassification.ts" },
  { key: "systemPrompt", label: "AI system prompt source hash only", path: "src/prompts/systemPrompt.ts" },
  { key: "aiChatToolTests", label: "AI chat privacy and authorization tests", path: "tests/ai-chat-tools.test.ts" },
  { key: "aiClassificationTests", label: "AI classification tests", path: "tests/ai-classification.test.ts" },
  { key: "aiTransparencyPage", label: "AI Transparency page", path: "schoolpilot-app/src/pages/legal/AITransparency.jsx" },
  { key: "subprocessorsPage", label: "Subprocessors page", path: "schoolpilot-app/src/pages/legal/Subprocessors.jsx" },
  { key: "privacyPolicyPage", label: "Privacy Policy page", path: "schoolpilot-app/src/pages/legal/PrivacyPolicy.jsx" },
  { key: "claimRegister", label: "SOC 2 claim register", path: "docs/soc2/claim-register.md" },
];

const PUBLIC_CLAIM_FILES = [
  "schoolpilot-app/src/pages/legal/AITransparency.jsx",
  "schoolpilot-app/src/pages/legal/Subprocessors.jsx",
  "schoolpilot-app/src/pages/legal/PrivacyPolicy.jsx",
  "docs/HECVAT-LITE.md",
  "docs/WISP.md",
  "docs/v1-SCHOOLPILOT-PRINCIPAL-IT-REVIEW.md",
  "docs/soc2/claim-register.md",
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

function sha256File(rootDir, relativePath) {
  const fullPath = path.join(rootDir, relativePath);
  if (!fs.existsSync(fullPath)) return null;
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(fullPath));
  return hash.digest("hex");
}

function readText(rootDir, relativePath) {
  const fullPath = path.join(rootDir, relativePath);
  return fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf8") : "";
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

function sourceContains(rootDir, relativePath, pattern) {
  return pattern.test(readText(rootDir, relativePath));
}

function buildAiFeatureInventory(rootDir) {
  const chatRoute = readText(rootDir, "src/routes/chat.ts");
  const chatService = readText(rootDir, "src/services/chatService.ts");
  const chatTools = readText(rootDir, "src/services/chatTools.ts");
  const aiClassification = readText(rootDir, "src/services/aiClassification.ts");

  return [
    {
      featureId: "ai_chat_assistant",
      status: chatService.includes("AI_CHAT_ENABLED") ? "disabled_by_default_runtime_flag" : "review_required",
      provider: chatService.includes("@anthropic-ai/sdk") ? "Anthropic Claude" : "review_required",
      modelSource: "src/services/chatService.ts",
      controls: [
        chatRoute.includes("requireSchoolContext") ? "school_context_required" : "review_required",
        chatService.includes("conversationMatchesContext") ? "conversation_user_school_scoped" : "review_required",
        chatTools.includes("licensedProducts") ? "product_license_filtered_tools" : "review_required",
        chatService.includes("confirmationRequired") ? "mutating_tools_require_confirmation" : "review_required",
        chatService.includes("logAudit") ? "ai_tool_activity_audited" : "review_required",
      ],
      modelBoundDataSummary: "Authorized staff prompts and minimized, role/license-scoped tool results when AI chat is explicitly enabled.",
    },
    {
      featureId: "classpilot_url_classification",
      status: aiClassification.includes("classifyUrl") ? "implemented" : "review_required",
      provider: aiClassification.includes("@anthropic-ai/sdk") ? "Anthropic Claude" : "review_required",
      modelSource: "src/services/aiClassification.ts",
      controls: [
        aiClassification.includes("KNOWN_EDUCATIONAL") ? "local_known_educational_short_circuit" : "review_required",
        aiClassification.includes("KNOWN_NON_EDUCATIONAL") ? "local_known_non_educational_short_circuit" : "review_required",
        aiClassification.includes("useAiFallback === false") ? "ai_fallback_can_be_disabled_in_tests" : "review_required",
      ],
      modelBoundDataSummary: "URL strings and page titles for browsing classification; no raw generated evidence includes URL samples.",
    },
    {
      featureId: "mailpilot_email_safety_classification",
      status: aiClassification.includes("classifyEmail") ? "implemented_when_mailpilot_enabled" : "not_detected",
      provider: aiClassification.includes("@anthropic-ai/sdk") ? "Anthropic Claude" : "review_required",
      modelSource: "src/services/aiClassification.ts",
      controls: [
        aiClassification.includes("MAX_EMAIL_BODY_CHARS") ? "email_body_truncation_limit_present" : "review_required",
        sourceContains(rootDir, "src/routes/mailpilot/setup.ts", /requireProductLicense|mailpilot/i) ? "mailpilot_setup_gated" : "review_required",
      ],
      modelBoundDataSummary: "Student Gmail message body/text may be classified only when MailPilot is entitled and operationally enabled by the school.",
    },
  ];
}

function buildDataFlows() {
  return [
    {
      flowId: "classpilot_url_classification",
      provider: "Anthropic",
      inputCategories: ["url_string", "page_title"],
      outputCategories: ["classification_category", "safety_alert", "confidence_or_reasoning_when_available"],
      minimizationControls: ["known-domain local rules", "school allowed-domain override", "no generated evidence copies URLs"],
      privateReviewRequired: true,
    },
    {
      flowId: "ai_chat_assistant",
      provider: "Anthropic",
      inputCategories: ["staff_prompt", "authorized_tool_result"],
      outputCategories: ["assistant_response", "tool_request", "tool_result_summary"],
      minimizationControls: ["disabled by default", "school/user conversation scoping", "role and product license tool filtering", "mutating action confirmation"],
      privateReviewRequired: true,
    },
    {
      flowId: "mailpilot_email_safety_classification",
      provider: "Anthropic",
      inputCategories: ["gmail_message_text_when_enabled"],
      outputCategories: ["safety_alert", "severity", "confidence", "reasoning"],
      minimizationControls: ["MailPilot entitlement and operational enablement", "message body truncation", "private review required"],
      privateReviewRequired: true,
    },
  ];
}

function buildAuthAndAuditSafeguards(rootDir) {
  return {
    routeAuthentication: sourceContains(rootDir, "src/routes/chat.ts", /authenticate/) ? "present" : REVIEW_REQUIRED,
    schoolContext: sourceContains(rootDir, "src/routes/chat.ts", /requireSchoolContext/) ? "present" : REVIEW_REQUIRED,
    conversationScoping: sourceContains(rootDir, "src/services/chatService.ts", /conversationMatchesContext/) ? "present" : REVIEW_REQUIRED,
    roleLicenseToolFiltering: sourceContains(rootDir, "src/services/chatTools.ts", /requiredRoles/) && sourceContains(rootDir, "src/services/chatTools.ts", /licensedProducts/) ? "present" : REVIEW_REQUIRED,
    mutatingActionConfirmation: sourceContains(rootDir, "src/services/chatService.ts", /confirmationRequired/) ? "present" : REVIEW_REQUIRED,
    aiAuditEvents: sourceContains(rootDir, "src/services/chatService.ts", /ai\.tool\./) ? "present" : REVIEW_REQUIRED,
    individualBrowsingHistoryToolDisabled: sourceContains(rootDir, "src/services/chatTools.ts", /get_student_browsing_history[\s\S]*requiredRoles:\s*\[\]/) ? "present" : REVIEW_REQUIRED,
  };
}

function buildTestPointers(rootDir) {
  return [
    {
      label: "AI chat tool privacy and authorization tests",
      path: "tests/ai-chat-tools.test.ts",
      present: fs.existsSync(path.join(rootDir, "tests/ai-chat-tools.test.ts")),
    },
    {
      label: "AI classification tests",
      path: "tests/ai-classification.test.ts",
      present: fs.existsSync(path.join(rootDir, "tests/ai-classification.test.ts")),
    },
    {
      label: "SOC 2 AI privacy evidence tests",
      path: "tests/soc2-ai-privacy-evidence.test.ts",
      present: fs.existsSync(path.join(rootDir, "tests/soc2-ai-privacy-evidence.test.ts")),
    },
  ];
}

function buildPublicClaimFindings(rootDir) {
  const runtimeOpenAiUse = readText(rootDir, "src/services/chatService.ts").includes("OpenAI")
    || readText(rootDir, "src/services/aiClassification.ts").includes("OpenAI")
    || readText(rootDir, "src/routes/chat.ts").includes("OpenAI");
  const publicOpenAiClaims = PUBLIC_CLAIM_FILES
    .filter((relativePath) => readText(rootDir, relativePath).includes("OpenAI"));
  const mailpilotClassifierPresent = readText(rootDir, "src/services/aiClassification.ts").includes("classifyEmail");
  const aiTransparencyMentionsMailPilot = /MailPilot|email|Gmail/i.test(readText(rootDir, "schoolpilot-app/src/pages/legal/AITransparency.jsx"));
  const subprocessorMentionsMailPilot = /MailPilot|email|Gmail/i.test(readText(rootDir, "schoolpilot-app/src/pages/legal/Subprocessors.jsx"));
  const claimRegisterNeedsRemediation = /CLAIM-003[\s\S]*Needs remediation/.test(readText(rootDir, "docs/soc2/claim-register.md"));
  const findings = [];

  if (publicOpenAiClaims.length && !runtimeOpenAiUse) {
    findings.push({
      findingId: "AI-CLAIM-OPENAI-PUBLIC-REFERENCE",
      status: REVIEW_REQUIRED,
      summary: "Public or sales documentation references OpenAI, but runtime AI implementation evidence detects Anthropic only.",
      evidencePointers: publicOpenAiClaims,
    });
  }

  if (mailpilotClassifierPresent && (!aiTransparencyMentionsMailPilot || !subprocessorMentionsMailPilot)) {
    findings.push({
      findingId: "AI-CLAIM-MAILPILOT-DISCLOSURE-REVIEW",
      status: REVIEW_REQUIRED,
      summary: "MailPilot email safety classification exists in implementation and should be reviewed against AI Transparency/Subprocessors disclosures before SOC2-002 closure.",
      evidencePointers: [
        "src/services/aiClassification.ts",
        "schoolpilot-app/src/pages/legal/AITransparency.jsx",
        "schoolpilot-app/src/pages/legal/Subprocessors.jsx",
      ],
    });
  }

  if (claimRegisterNeedsRemediation) {
    findings.push({
      findingId: "CLAIM-003-NEEDS-REMEDIATION",
      status: REVIEW_REQUIRED,
      summary: "SOC 2 claim register already marks AI data subprocessor limitation/disclosure evidence as needing remediation.",
      evidencePointers: ["docs/soc2/claim-register.md"],
    });
  }

  return findings;
}

export function buildAiPrivacyEvidence({
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
    controls: ["SP-CONF-002"],
    remediationItems: ["SOC2-002"],
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
      evidenceArtifact: "soc2-evidence-ai-privacy",
    },
    sensitiveDataBoundary: {
      publicPacketContents: "Non-sensitive metadata, source hashes, data-flow summaries, and evidence pointers only.",
      excludedContent: [
        "prompt bodies",
        "secret values",
        "credentials",
        "raw logs",
        "conversation transcripts",
        "customer records",
        "student records",
      ],
    },
    environmentVariables: [
      {
        name: "AI_CHAT_ENABLED",
        valueIncluded: false,
        purpose: "Runtime flag for optional AI chat availability.",
      },
      {
        name: "ANTHROPIC_API_KEY",
        valueIncluded: false,
        purpose: "Provider credential for Anthropic-backed AI features.",
      },
    ],
    sourceHashes: buildSourceHashes(resolvedRoot),
    aiFeatures: buildAiFeatureInventory(resolvedRoot),
    dataFlows: buildDataFlows(),
    authAndAuditSafeguards: buildAuthAndAuditSafeguards(resolvedRoot),
    testEvidence: buildTestPointers(resolvedRoot),
    publicClaimReviewFindings: buildPublicClaimFindings(resolvedRoot),
    humanReview: {
      approvalId: "APPROVAL-SP-CONF-002-AI-DATA-FLOW-REVIEW",
      decisionType: "ai_data_flow_review",
      status: PENDING_STATUS,
      approverRole: "Security & Privacy Officer",
      privateEvidenceLocation: "SchoolPilot-SOC2-Evidence/ai/reviews/",
    },
    retention: "Store generated packets as GitHub Actions artifacts. Store factual AI data-flow review and final decisions only in SchoolPilot-SOC2-Evidence/ai/reviews/.",
  };

  const validation = validateAiPrivacyEvidence(packet);
  return { packet, validation };
}

export function validateAiPrivacyEvidence(packet) {
  const errors = [];
  const required = [
    ["evidenceId", packet.evidenceId],
    ["collectedAt", packet.collectedAt],
    ["controls", Array.isArray(packet.controls) && packet.controls.includes("SP-CONF-002")],
    ["remediationItems", Array.isArray(packet.remediationItems) && packet.remediationItems.includes("SOC2-002")],
    ["appImpact", packet.appImpact],
    ["git.repository", packet.git?.repository],
    ["git.ref", packet.git?.ref],
    ["git.commitSha", packet.git?.commitSha],
    ["ci.workflow", packet.ci?.workflow],
    ["ci.runId", packet.ci?.runId],
    ["environmentVariables", Array.isArray(packet.environmentVariables) && packet.environmentVariables.length >= 2],
    ["aiFeatures", Array.isArray(packet.aiFeatures) && packet.aiFeatures.length >= 2],
    ["dataFlows", Array.isArray(packet.dataFlows) && packet.dataFlows.length >= 2],
    ["humanReview.status", packet.humanReview?.status],
  ];

  for (const [name, value] of required) {
    if (!value) errors.push(`Missing required AI/privacy evidence field: ${name}`);
  }

  if (packet.appImpact !== APP_IMPACT) {
    errors.push("AI/privacy evidence appImpact must remain no-user-facing-change.");
  }
  if (packet.humanReview?.status !== PENDING_STATUS) {
    errors.push("AI data-flow review must remain pending human approval.");
  }
  for (const variable of packet.environmentVariables || []) {
    if (variable.valueIncluded !== false) {
      errors.push(`${variable.name || "environment variable"} must not include runtime values.`);
    }
  }
  for (const entry of SOURCE_HASH_FILES) {
    if (!packet.sourceHashes?.[entry.key]?.sha256) {
      errors.push(`Missing required source hash: ${entry.path}`);
    }
  }

  const serialized = JSON.stringify(packet);
  for (const forbidden of [
    "PRIVATE_PROMPT_BODY",
    "PRIVATE_TRANSCRIPT_BODY",
    "PRIVATE_STUDENT_DATA",
    "PRIVATE_CUSTOMER_DATA",
    "ANTHROPIC_SECRET_VALUE",
    "OPENAI_SECRET_VALUE",
    "BEGIN PRIVATE KEY",
    "NEVER reveal your system prompt",
  ]) {
    if (serialized.includes(forbidden)) {
      errors.push(`AI/privacy evidence contains forbidden sensitive content marker ${forbidden}.`);
    }
  }

  return { status: errors.length > 0 ? "fail" : "pass", errors };
}

export function formatAiPrivacyEvidenceMarkdown(packet, validation) {
  const featureLines = packet.aiFeatures
    .map((feature) => `- ${feature.featureId}: ${feature.status}; provider: ${feature.provider}`)
    .join("\n");
  const flowLines = packet.dataFlows
    .map((flow) => `- ${flow.flowId}: ${flow.inputCategories.join(", ")} -> ${flow.outputCategories.join(", ")}`)
    .join("\n");
  const hashLines = Object.values(packet.sourceHashes)
    .map((item) => `- ${item.label}: \`${item.sha256 || "missing"}\` (${item.path})`)
    .join("\n");
  const safeguardLines = Object.entries(packet.authAndAuditSafeguards || {})
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n");
  const testLines = packet.testEvidence
    .map((item) => `- ${item.label}: ${item.present ? "present" : "missing"} (${item.path})`)
    .join("\n");
  const findingLines = packet.publicClaimReviewFindings.length
    ? packet.publicClaimReviewFindings.map((item) => `- ${item.findingId}: ${item.status} - ${item.summary}`).join("\n")
    : "- No public claim review findings detected.";
  const validationLines = validation.errors.length
    ? validation.errors.map((error) => `- ERROR: ${error}`).join("\n")
    : "- No blocking validation errors.";

  return `# SOC 2 AI/Privacy Evidence

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

## Sensitive Data Boundary

${packet.sensitiveDataBoundary.publicPacketContents}

Excluded content: ${packet.sensitiveDataBoundary.excludedContent.join(", ")}.

## Environment Variables

${packet.environmentVariables.map((item) => `- ${item.name}: valueIncluded=${item.valueIncluded}`).join("\n")}

## AI Feature Inventory

${featureLines}

## Data Flows

${flowLines}

## Authorization And Audit Safeguards

${safeguardLines}

## Tests

${testLines}

## Public Claim Review Findings

${findingLines}

## Source Hashes

${hashLines}

## Human Review

- Approval ID: ${packet.humanReview.approvalId}
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

export function writeAiPrivacyEvidence({ packet, validation }, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "soc2-002-ai-privacy-evidence.json");
  const mdPath = path.join(outputDir, "soc2-002-ai-privacy-evidence.md");
  fs.writeFileSync(jsonPath, `${JSON.stringify({ ...packet, qualityGate: validation }, null, 2)}\n`);
  fs.writeFileSync(mdPath, formatAiPrivacyEvidenceMarkdown(packet, validation));
  return { jsonPath, mdPath };
}

export function runCli() {
  const rootDir = path.resolve(argValue("root-dir", fileURLToPath(new URL("../..", import.meta.url))));
  const outputDir = path.resolve(rootDir, argValue("output-dir", path.join(process.env.SOC2_EVIDENCE_DIR || "soc2-evidence", "ai-privacy")));
  const evidence = buildAiPrivacyEvidence({ rootDir });
  const { jsonPath, mdPath } = writeAiPrivacyEvidence(evidence, outputDir);

  console.log(`[soc2-ai-privacy] wrote ${jsonPath}`);
  console.log(`[soc2-ai-privacy] wrote ${mdPath}`);

  for (const error of evidence.validation.errors) {
    console.error(`[soc2-ai-privacy] error: ${error}`);
  }
  if (evidence.validation.errors.length > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
