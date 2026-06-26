#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function argValue(name, fallback = "") {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env[name.toUpperCase().replace(/-/g, "_")] || fallback;
}

const outputDir = argValue("output-dir", process.env.SOC2_EVIDENCE_DIR || "soc2-evidence");
const jobName = argValue("job", process.env.GITHUB_JOB || "local");
const controlIds = argValue("controls", "SP-SEC-004");
const summary = argValue("summary", "CI control evidence");
const status = argValue("status", process.env.JOB_STATUS || "unknown");
const now = new Date().toISOString();
const safeJob = jobName.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "job";
const runId = process.env.GITHUB_RUN_ID || "local";
const runAttempt = process.env.GITHUB_RUN_ATTEMPT || "1";
const evidenceId = `${now.replace(/[:.]/g, "-")}-${safeJob}`;

const evidence = {
  evidenceId,
  collectedAt: now,
  sourceSystem: "github-actions",
  job: jobName,
  status,
  summary,
  controls: controlIds.split(",").map((s) => s.trim()).filter(Boolean),
  repository: process.env.GITHUB_REPOSITORY || "local",
  workflow: process.env.GITHUB_WORKFLOW || "local",
  runId,
  runAttempt,
  runUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : "",
  actor: process.env.GITHUB_ACTOR || "",
  ref: process.env.GITHUB_REF || "",
  sha: process.env.GITHUB_SHA || "",
  eventName: process.env.GITHUB_EVENT_NAME || "",
  retention: "Store in private SOC 2 evidence repository or workflow artifact retention.",
};

fs.mkdirSync(outputDir, { recursive: true });
const jsonPath = path.join(outputDir, `${evidenceId}.json`);
const mdPath = path.join(outputDir, `${evidenceId}.md`);

fs.writeFileSync(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`);
fs.writeFileSync(mdPath, `# SOC 2 CI Evidence: ${jobName}

- Evidence ID: ${evidence.evidenceId}
- Collected at: ${evidence.collectedAt}
- Status: ${evidence.status}
- Controls: ${evidence.controls.join(", ")}
- Repository: ${evidence.repository}
- Workflow: ${evidence.workflow}
- Run: ${evidence.runUrl || `${evidence.runId}.${evidence.runAttempt}`}
- Actor: ${evidence.actor}
- Ref: ${evidence.ref}
- Commit: ${evidence.sha}
- Event: ${evidence.eventName}

## Summary

${summary}

## Retention

${evidence.retention}
`);

console.log(`[soc2-evidence] wrote ${jsonPath}`);
console.log(`[soc2-evidence] wrote ${mdPath}`);
