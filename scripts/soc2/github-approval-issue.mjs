#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MARKER = "schoolpilot-soc2-approval-queue";
const DEFAULT_AUTHORIZED_ACTORS = ["bzinkan"];

function argValue(name, fallback = "") {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env[name.toUpperCase().replace(/-/g, "_")] || fallback;
}

function readJson(fullPath) {
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function readText(fullPath) {
  return fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf8") : "";
}

function latestQueueFile(rootDir) {
  const queueDir = path.join(rootDir, process.env.SOC2_EVIDENCE_DIR || "soc2-evidence", "approvals");
  if (!fs.existsSync(queueDir)) return "";
  return fs
    .readdirSync(queueDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const fullPath = path.join(queueDir, name);
      return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.fullPath || "";
}

function parseAuthorizedActors(value = "") {
  return value
    .split(",")
    .map((actor) => actor.trim().toLowerCase())
    .filter(Boolean);
}

function githubRunUrl(env = process.env) {
  if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) {
    return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  }
  return "";
}

function hiddenMetadata(queue, env = process.env) {
  return {
    queueId: queue.queueId,
    runId: env.GITHUB_RUN_ID || queue.runId || "local",
    runAttempt: env.GITHUB_RUN_ATTEMPT || queue.runAttempt || "1",
    runUrl: githubRunUrl(env) || queue.runUrl || "",
    artifactName: "soc2-approval-queue",
  };
}

function commandExample(item, command) {
  const verb = command === "approve" ? "approve" : "reject";
  const rationale = command === "approve"
    ? "Evidence reviewed and acceptable for the current observation period."
    : "Evidence is missing or not acceptable yet.";
  return `/${verb} ${item.approvalId} ${rationale}`;
}

function formatItem(item) {
  const pointerLines = (item.evidencePointers || [])
    .map((pointer) => `  - ${pointer.label}: ${pointer.location}`)
    .join("\n");

  return `### ${item.approvalId}

- Control: ${item.controlId}
- Decision type: ${item.decisionType}
- Status: ${item.status}
- Recommended decision: ${item.recommendedDecision}
- Approver role: ${item.approverRole || "not_specified"}
- Expires: ${item.expiresAt || "not_applicable"}
- App impact: ${item.appImpact}
- Evidence pointers:
${pointerLines || "  - No evidence pointers available."}

Approve:

\`\`\`text
${commandExample(item, "approve")}
\`\`\`

Reject:

\`\`\`text
${commandExample(item, "reject")}
\`\`\`
`;
}

function formatReadinessGap(gap) {
  const evidenceLines = (gap.requiredEvidence || [])
    .map((item) => {
      const status = item.present ? "present" : "missing";
      return `  - ${item.label}: ${status} (${item.location})`;
    })
    .join("\n");

  return `### Gap: ${gap.approvalId}

- Control: ${gap.controlId}
- Decision type: ${gap.decisionType}
- Status: ${gap.status}
- Reason: ${gap.reason}
- App impact: ${gap.appImpact}
- Required private evidence:
${evidenceLines || "  - No private evidence requirements available."}

Add the missing private evidence, then rerun the SOC 2 approval queue. This item
does not accept an approval command until it is ready.
`;
}

export function formatApprovalIssueBody(queue, env = process.env) {
  const metadata = hiddenMetadata(queue, env);
  const items = queue.items || [];
  const itemSections = items.length
    ? items.map(formatItem).join("\n")
    : "No pending SOC 2 approvals were generated.";
  const readinessGaps = queue.readinessGaps || [];
  const readinessGapSections = readinessGaps.length
    ? readinessGaps.map(formatReadinessGap).join("\n")
    : "No private evidence readiness gaps were reported.";

  return `<!-- ${MARKER} ${JSON.stringify(metadata)} -->
# SOC 2 Approvals Pending

Automation generated a SOC 2 approval queue. This issue is the review inbox:
comment with an approval command to record a human decision in the private
evidence repository.

- Queue ID: ${queue.queueId}
- Pending approvals: ${queue.itemCount}
- Readiness gaps: ${queue.readinessGapCount || 0}
- Suppressed completed decisions: ${queue.suppressedApprovalCount || 0}
- Generated at: ${queue.generatedAt}
- Source run: ${metadata.runUrl || `${metadata.runId}.${metadata.runAttempt}`}
- Artifact: ${metadata.artifactName}
- App impact: ${queue.appImpact}

## How to Decide

Comment on this issue with one of these forms:

\`\`\`text
/approve APPROVAL-ID rationale
/reject APPROVAL-ID rationale
\`\`\`

Examples:

\`\`\`text
/approve APPROVAL-SP-SEC-004-PRODUCTION-DEPLOYMENT-APPROVAL CI was green and deployment evidence was reviewed.
/reject APPROVAL-SP-SEC-005-VENDOR-DPA-CONFIRMATION DPA evidence is not present in the private evidence repo yet.
\`\`\`

Only authorized GitHub users may record SOC 2 decisions. Automation may draft
and route this queue, but it never approves a decision on its own.

## Pending Items

${itemSections}

## Private Evidence Readiness Gaps

${readinessGapSections}
`;
}

export function extractIssueMetadata(issueBody = "") {
  const marker = new RegExp(`<!--\\s*${MARKER}\\s+({[\\s\\S]*?})\\s*-->`);
  const match = issueBody.match(marker);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export function parseApprovalComment({ commentBody, actor, issueBody, authorizedActors = DEFAULT_AUTHORIZED_ACTORS }) {
  const normalizedActor = String(actor || "").toLowerCase();
  const allowedActors = authorizedActors.map((item) => item.toLowerCase());
  const trimmed = String(commentBody || "").trim();
  const match = trimmed.match(/^\/(approve|reject)\s+([A-Z0-9_.:-]+)\s+([\s\S]+)$/i);

  if (!match) {
    return {
      shouldProcess: false,
      error: "Comment is not a SOC 2 approval command. Use /approve APPROVAL-ID rationale or /reject APPROVAL-ID rationale.",
    };
  }

  if (!allowedActors.includes(normalizedActor)) {
    return {
      shouldProcess: false,
      error: `GitHub actor ${actor || "(unknown)"} is not authorized to record SOC 2 approvals.`,
    };
  }

  const metadata = extractIssueMetadata(issueBody);
  if (!metadata?.runId || !metadata?.artifactName) {
    return {
      shouldProcess: false,
      error: "Issue does not contain SOC 2 approval queue metadata.",
    };
  }

  const rationale = match[3].trim();
  if (!rationale) {
    return {
      shouldProcess: false,
      error: "Approval rationale is required.",
    };
  }

  return {
    shouldProcess: true,
    command: match[1].toLowerCase(),
    decision: match[1].toLowerCase() === "approve" ? "approved" : "not_approved",
    approvalId: match[2].toUpperCase(),
    rationale,
    queueId: metadata.queueId || "",
    queueRunId: String(metadata.runId),
    queueRunAttempt: String(metadata.runAttempt || "1"),
    artifactName: metadata.artifactName,
  };
}

function writeGithubOutput(values, outputFile) {
  const lines = [];
  for (const [key, value] of Object.entries(values)) {
    const normalized = value === undefined || value === null ? "" : String(value);
    if (normalized.includes("\n")) {
      const delimiter = `EOF_${key}_${Date.now()}`;
      lines.push(`${key}<<${delimiter}\n${normalized}\n${delimiter}`);
    } else {
      lines.push(`${key}=${normalized}`);
    }
  }
  fs.appendFileSync(outputFile, `${lines.join("\n")}\n`);
}

function runIssueBodyCli() {
  const rootDir = path.resolve(argValue("root-dir", fileURLToPath(new URL("../..", import.meta.url))));
  const queueFile = path.resolve(rootDir, argValue("queue-file", latestQueueFile(rootDir)));
  const outputFile = argValue("output");

  if (!queueFile || !fs.existsSync(queueFile)) {
    console.error("[soc2-approval-issue] error: approval queue file not found. Run npm run soc2:approval-queue first.");
    process.exit(1);
  }

  const queue = readJson(queueFile);
  const body = formatApprovalIssueBody(queue);

  if (outputFile) {
    const resolvedOutput = path.resolve(rootDir, outputFile);
    fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
    fs.writeFileSync(resolvedOutput, body);
    console.log(`[soc2-approval-issue] wrote ${resolvedOutput}`);
  } else {
    process.stdout.write(body);
  }
}

function runParseCommentCli() {
  const eventPath = argValue("event-path", process.env.GITHUB_EVENT_PATH || "");
  const issueBodyFile = argValue("issue-body-file");
  const outputFile = argValue("output-file", process.env.GITHUB_OUTPUT || "");
  const event = eventPath ? readJson(eventPath) : {};
  const issueBody = issueBodyFile ? readText(path.resolve(issueBodyFile)) : event.issue?.body || "";
  const authorizedActors = parseAuthorizedActors(process.env.SOC2_APPROVAL_AUTHORIZED_ACTORS || DEFAULT_AUTHORIZED_ACTORS.join(","));
  const result = parseApprovalComment({
    commentBody: event.comment?.body || "",
    actor: event.comment?.user?.login || "",
    issueBody,
    authorizedActors,
  });

  const output = {
    should_process: result.shouldProcess ? "true" : "false",
    error: result.error || "",
    command: result.command || "",
    decision: result.decision || "",
    approval_id: result.approvalId || "",
    rationale: result.rationale || "",
    queue_id: result.queueId || "",
    queue_run_id: result.queueRunId || "",
    queue_run_attempt: result.queueRunAttempt || "",
    artifact_name: result.artifactName || "",
  };

  if (outputFile) {
    writeGithubOutput(output, outputFile);
  } else {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  }

  if (!result.shouldProcess) {
    console.error(`[soc2-approval-issue] ${result.error}`);
  }
}

export function runCli() {
  const command = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "issue-body";
  if (command === "parse-comment") {
    runParseCommentCli();
    return;
  }
  runIssueBodyCli();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
