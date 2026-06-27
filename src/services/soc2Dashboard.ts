import fs from "node:fs";
import path from "node:path";

const APP_IMPACT = "No user-facing behavior changed";
const DEFAULT_REPO = "bzinkan/SchoolPilot";
const DEFAULT_APPROVAL_ISSUE_NUMBER = 146;
const DEFAULT_WORKFLOW = "ci-build.yml";
const GITHUB_API = "https://api.github.com";

type FetchLike = typeof fetch;

type SourceStatus = "available" | "unavailable";

interface GitHubConfig {
  owner: string;
  repo: string;
  repository: string;
  approvalIssueNumber: number;
  workflow: string;
  token?: string;
}

interface GitHubIssue {
  number: number;
  title: string;
  html_url: string;
  state: string;
  updated_at: string;
  body?: string | null;
}

interface GitHubComment {
  body?: string | null;
  created_at: string;
  html_url: string;
  user?: {
    login?: string;
  } | null;
}

interface GitHubWorkflowRun {
  id: number;
  name?: string | null;
  status: string;
  conclusion?: string | null;
  event: string;
  head_branch?: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
}

interface GitHubAlert {
  number: number;
  state: string;
  html_url: string;
  rule?: {
    id?: string;
    severity?: string;
  };
  secret_type?: string;
}

interface Soc2DashboardOptions {
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  now?: Date;
}

interface GitHubSectionResult<T> {
  status: SourceStatus;
  data: T;
  error?: string;
}

type ApprovalIssueParse = ReturnType<typeof parseApprovalIssueBody>;

interface ApprovalIssueDashboardData {
  issue: {
    number: number;
    title: string;
    state: string;
    url: string;
    updatedAt: string;
  } | null;
  queueMetadata: ApprovalIssueParse["queueMetadata"] | null;
  pendingApprovals: ApprovalIssueParse["pendingApprovals"];
  readinessGaps: ApprovalIssueParse["readinessGaps"];
  recordedDecisions: ReturnType<typeof parseRecordedDecisionComments>;
}

function envValue(env: NodeJS.ProcessEnv, key: string, fallback = "") {
  return env[key] || fallback;
}

function repoConfig(env: NodeJS.ProcessEnv): GitHubConfig {
  const repository = envValue(env, "SOC2_DASHBOARD_REPO", DEFAULT_REPO);
  const [owner = "bzinkan", repo = "SchoolPilot"] = repository.split("/");
  return {
    owner,
    repo,
    repository: `${owner}/${repo}`,
    approvalIssueNumber: Number(envValue(env, "SOC2_APPROVAL_ISSUE_NUMBER", String(DEFAULT_APPROVAL_ISSUE_NUMBER))) || DEFAULT_APPROVAL_ISSUE_NUMBER,
    workflow: envValue(env, "SOC2_DASHBOARD_WORKFLOW", DEFAULT_WORKFLOW),
    token: env.SOC2_DASHBOARD_GITHUB_TOKEN,
  };
}

function readText(rootDir: string, relativePath: string) {
  const fullPath = path.join(rootDir, relativePath);
  return fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf8") : "";
}

function readJson<T>(rootDir: string, relativePath: string): T | null {
  const text = readText(rootDir, relativePath);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function splitMarkdownRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim().replace(/<br\s*\/?>/gi, " "));
}

export function parseMarkdownTable(markdown: string) {
  const tableLines = markdown
    .split(/\r?\n/)
    .filter((line) => /^\s*\|/.test(line));
  if (tableLines.length < 3) return [];

  const headers = splitMarkdownRow(tableLines[0] || "");
  const rows: Record<string, string>[] = [];

  for (const line of tableLines.slice(2)) {
    const cells = splitMarkdownRow(line);
    if (cells.length !== headers.length) continue;
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;

    const row: Record<string, string> = {};
    headers.forEach((header, idx) => {
      row[header] = cells[idx] || "";
    });
    rows.push(row);
  }

  return rows;
}

function parseKeyValue(section: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = section.match(new RegExp(`^- ${escaped}:\\s*(.+)$`, "mi"));
  return match?.[1]?.trim() || "";
}

function splitSections(markdown: string, headingPattern: RegExp) {
  const matches = [...markdown.matchAll(headingPattern)];
  return matches.map((match, idx) => {
    const next = matches[idx + 1];
    const start = match.index || 0;
    const end = next?.index ?? markdown.length;
    return {
      id: match[1] || "",
      text: markdown.slice(start, end),
    };
  });
}

function parseEvidencePointers(section: string) {
  const pointers: Array<{ label: string; location: string }> = [];
  const pointerBlock = section.split(/- Evidence pointers:\s*/i)[1]?.split(/\n\n/)[0] || "";
  for (const line of pointerBlock.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+([^:]+):\s*(.+)$/);
    if (match?.[1] && match?.[2]) {
      pointers.push({ label: match[1].trim(), location: match[2].trim() });
    }
  }
  return pointers;
}

function commandFor(section: string, verb: "approve" | "reject", approvalId: string) {
  const match = section.match(new RegExp(`/${verb}\\s+${approvalId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n\`]*`, "i"));
  return match?.[0]?.trim() || `/${verb} ${approvalId} rationale`;
}

export function parseApprovalIssueBody(body = "") {
  const queueMetadata = {
    queueId: parseKeyValue(body, "Queue ID"),
    pendingApprovals: Number(parseKeyValue(body, "Pending approvals")) || 0,
    readinessGaps: Number(parseKeyValue(body, "Readiness gaps")) || 0,
    suppressedCompletedDecisions: Number(parseKeyValue(body, "Suppressed completed decisions")) || 0,
    generatedAt: parseKeyValue(body, "Generated at"),
    sourceRun: parseKeyValue(body, "Source run"),
    artifact: parseKeyValue(body, "Artifact"),
    appImpact: parseKeyValue(body, "App impact") || APP_IMPACT,
  };

  const pendingRegion = body.split("## Pending Items")[1]?.split("## Private Evidence Readiness Gaps")[0] || "";
  const pendingApprovals = splitSections(pendingRegion, /^###\s+(APPROVAL-[A-Z0-9_.:-]+)/gmi).map(({ id, text }) => ({
    approvalId: id,
    controlId: parseKeyValue(text, "Control"),
    decisionType: parseKeyValue(text, "Decision type"),
    status: parseKeyValue(text, "Status"),
    recommendedDecision: parseKeyValue(text, "Recommended decision"),
    approverRole: parseKeyValue(text, "Approver role"),
    expiresAt: parseKeyValue(text, "Expires"),
    appImpact: parseKeyValue(text, "App impact") || APP_IMPACT,
    evidencePointers: parseEvidencePointers(text),
    approveCommand: commandFor(text, "approve", id),
    rejectCommand: commandFor(text, "reject", id),
  }));

  const gapRegion = body.split("## Private Evidence Readiness Gaps")[1] || "";
  const readinessGaps = splitSections(gapRegion, /^###\s+Gap:\s+(APPROVAL-[A-Z0-9_.:-]+)/gmi).map(({ id, text }) => {
    const requiredEvidence = [...text.matchAll(/^\s+-\s+([^:]+):\s+([^(]+?)(?:\s+\(([^)]+)\))?\s*$/gmi)]
      .map((match) => ({
        label: match[1]?.trim() || "",
        status: match[2]?.trim() || "",
        location: match[3]?.trim() || "",
      }))
      .filter((item) => item.label && !["Control", "Decision type", "Status", "Reason", "App impact"].includes(item.label));
    return {
      approvalId: id,
      controlId: parseKeyValue(text, "Control"),
      decisionType: parseKeyValue(text, "Decision type"),
      status: parseKeyValue(text, "Status"),
      reason: parseKeyValue(text, "Reason"),
      appImpact: parseKeyValue(text, "App impact") || APP_IMPACT,
      requiredEvidence,
    };
  });

  return {
    queueMetadata,
    pendingApprovals,
    readinessGaps,
  };
}

export function parseRecordedDecisionComments(comments: GitHubComment[]) {
  return comments
    .map((comment) => {
      const body = comment.body || "";
      const match = body.match(/Recorded SOC 2 decision `([^`]+)` for `(APPROVAL-[^`]+)` by @([A-Za-z0-9-]+)/);
      if (!match) return null;
      return {
        approvalId: match[2] || "",
        decision: match[1] || "",
        actor: match[3] || comment.user?.login || "",
        createdAt: comment.created_at,
        url: comment.html_url,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(-20)
    .reverse();
}

function groupByStatus(rows: Array<{ status?: string }>) {
  return rows.reduce<Record<string, number>>((acc, row) => {
    const status = row.status || "Unknown";
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
}

function localDocs(rootDir: string) {
  const governance = readJson<{ controls?: Array<Record<string, unknown>> }>(rootDir, "docs/soc2/governance-controls.json");
  const remediationRows = parseMarkdownTable(readText(rootDir, "docs/soc2/remediation-register.md"));
  const claimRows = parseMarkdownTable(readText(rootDir, "docs/soc2/claim-register.md"));
  const controls = (governance?.controls || []).map((control) => ({
    id: String(control.id || ""),
    owner: String(control.owner || ""),
    status: String(control.status || "Unknown"),
    frequency: String(control.frequency || ""),
    nextReviewDue: String(control.nextReviewDue || ""),
    automationImpact: String(control.automationImpact || ""),
  }));
  const remediations = remediationRows.map((row) => ({
    id: row.ID || "",
    priority: row.Priority || "",
    area: row.Area || "",
    gap: row.Gap || "",
    owner: row.Owner || "",
    target: row.Target || "",
    evidenceNeeded: row["Evidence Needed"] || "",
    status: row.Status || "",
  }));
  const claims = claimRows.map((row) => ({
    id: row["Claim ID"] || "",
    source: row.Source || "",
    claim: row.Claim || "",
    owner: row.Owner || "",
    evidenceNeeded: row["Evidence Needed"] || "",
    status: row.Status || "",
    action: row.Action || "",
  }));
  const openRemediations = remediations.filter((row) => !/^closed$/i.test(row.status));
  const claimsNeedingEvidence = claims.filter((row) => !/^(supported|ready)$/i.test(row.status));

  return {
    status: governance ? "available" as const : "unavailable" as const,
    controls,
    controlsByStatus: groupByStatus(controls),
    remediations,
    openRemediations,
    claims,
    claimsNeedingEvidence,
    sources: [
      "docs/soc2/governance-controls.json",
      "docs/soc2/remediation-register.md",
      "docs/soc2/claim-register.md",
    ],
  };
}

async function githubRequest<T>(fetchImpl: FetchLike, config: GitHubConfig, apiPath: string, init: RequestInit = {}): Promise<T> {
  if (!config.token) {
    throw new Error("SOC2_DASHBOARD_GITHUB_TOKEN is not configured.");
  }
  const response = await fetchImpl(`${GITHUB_API}${apiPath}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json() as { message?: string };
      detail = body.message ? `: ${body.message}` : "";
    } catch {
      detail = "";
    }
    throw new Error(`GitHub API ${response.status}${detail}`);
  }
  if (response.status === 204) return {} as T;
  return await response.json() as T;
}

async function optionalSection<T>(builder: () => Promise<T>, fallback: T): Promise<GitHubSectionResult<T>> {
  try {
    return { status: "available", data: await builder() };
  } catch (error) {
    return {
      status: "unavailable",
      data: fallback,
      error: error instanceof Error ? error.message : "Unavailable",
    };
  }
}

function summarizeAlerts(alerts: GitHubAlert[], type: "code_scanning" | "secret_scanning") {
  const bySeverity = alerts.reduce<Record<string, number>>((acc, alert) => {
    const severity = type === "secret_scanning" ? "secret" : alert.rule?.severity || "unknown";
    acc[severity] = (acc[severity] || 0) + 1;
    return acc;
  }, {});
  const sample = alerts.slice(0, 10).map((alert) => ({
    number: alert.number,
    rule: alert.rule?.id || alert.secret_type || type,
    severity: alert.rule?.severity || (type === "secret_scanning" ? "secret" : "unknown"),
    state: alert.state,
    url: alert.html_url,
  }));
  return {
    count: alerts.length,
    bySeverity,
    sample,
  };
}

async function githubDashboardData(fetchImpl: FetchLike, config: GitHubConfig) {
  const issueResult = await optionalSection<ApprovalIssueDashboardData>(async () => {
    const [issue, comments] = await Promise.all([
      githubRequest<GitHubIssue>(fetchImpl, config, `/repos/${config.owner}/${config.repo}/issues/${config.approvalIssueNumber}`),
      githubRequest<GitHubComment[]>(fetchImpl, config, `/repos/${config.owner}/${config.repo}/issues/${config.approvalIssueNumber}/comments?per_page=100`),
    ]);
    const parsed = parseApprovalIssueBody(issue.body || "");
    return {
      issue: {
        number: issue.number,
        title: issue.title,
        state: issue.state,
        url: issue.html_url,
        updatedAt: issue.updated_at,
      },
      ...parsed,
      recordedDecisions: parseRecordedDecisionComments(comments),
    };
  }, {
    issue: null,
    queueMetadata: null,
    pendingApprovals: [],
    readinessGaps: [],
    recordedDecisions: [],
  });

  const actionsResult = await optionalSection(async () => {
    const response = await githubRequest<{ workflow_runs?: GitHubWorkflowRun[] }>(
      fetchImpl,
      config,
      `/repos/${config.owner}/${config.repo}/actions/workflows/${encodeURIComponent(config.workflow)}/runs?branch=main&per_page=5`,
    );
    const runs = (response.workflow_runs || []).map((run) => ({
      id: run.id,
      name: run.name || "CI",
      status: run.status,
      conclusion: run.conclusion || "",
      event: run.event,
      branch: run.head_branch || "",
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      url: run.html_url,
    }));
    return {
      workflow: config.workflow,
      latestRun: runs[0] || null,
      recentRuns: runs,
    };
  }, {
    workflow: config.workflow,
    latestRun: null,
    recentRuns: [],
  });

  const codeScanningResult = await optionalSection(async () => {
    const alerts = await githubRequest<GitHubAlert[]>(
      fetchImpl,
      config,
      `/repos/${config.owner}/${config.repo}/code-scanning/alerts?state=open&per_page=100`,
    );
    return summarizeAlerts(alerts, "code_scanning");
  }, {
    count: 0,
    bySeverity: {},
    sample: [],
  });

  const secretScanningResult = await optionalSection(async () => {
    const alerts = await githubRequest<GitHubAlert[]>(
      fetchImpl,
      config,
      `/repos/${config.owner}/${config.repo}/secret-scanning/alerts?state=open&per_page=100`,
    );
    return summarizeAlerts(alerts, "secret_scanning");
  }, {
    count: 0,
    bySeverity: {},
    sample: [],
  });

  return {
    status: [issueResult, actionsResult, codeScanningResult, secretScanningResult].some((section) => section.status === "available")
      ? "available" as const
      : "unavailable" as const,
    issue: issueResult,
    actions: actionsResult,
    security: {
      codeScanning: codeScanningResult,
      secretScanning: secretScanningResult,
    },
  };
}

function overallStatus({
  pendingApprovals,
  readinessGaps,
  openRemediations,
  securityAlerts,
}: {
  pendingApprovals: number;
  readinessGaps: number;
  openRemediations: number;
  securityAlerts: number;
}) {
  if (securityAlerts > 0 || pendingApprovals > 0) return "action_required";
  if (readinessGaps > 0 || openRemediations > 0) return "in_progress";
  return "ready";
}

export async function buildSoc2DashboardReadiness(options: Soc2DashboardOptions = {}) {
  const rootDir = options.rootDir || process.cwd();
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || new Date();
  const config = repoConfig(env);
  const docs = localDocs(rootDir);
  const github = await githubDashboardData(fetchImpl, config);

  const pendingApprovals = github.issue.data.pendingApprovals.length;
  const readinessGaps = github.issue.data.readinessGaps.length;
  const completedDecisions = github.issue.data.recordedDecisions.length;
  const suppressedCompletedDecisions = github.issue.data.queueMetadata?.suppressedCompletedDecisions || 0;
  const codeAlerts = github.security.codeScanning.data.count;
  const secretAlerts = github.security.secretScanning.data.count;
  const securityAlerts = codeAlerts + secretAlerts;
  const totalControls = docs.controls.length;
  const readyControls = docs.controls.filter((control) => /^(Operating|Ready)$/i.test(control.status)).length;
  const readinessPercent = totalControls > 0 ? Math.round((readyControls / totalControls) * 100) : 0;
  const status = overallStatus({
    pendingApprovals,
    readinessGaps,
    openRemediations: docs.openRemediations.length,
    securityAlerts,
  });

  return {
    generatedAt: now.toISOString(),
    repository: config.repository,
    approvalIssueNumber: config.approvalIssueNumber,
    appImpact: APP_IMPACT,
    config: {
      tokenConfigured: Boolean(config.token),
      workflow: config.workflow,
    },
    overall: {
      status,
      readinessPercent,
      summary: status === "action_required"
        ? "SOC 2 items need review."
        : status === "in_progress"
          ? "SOC 2 evidence is in progress."
          : "SOC 2 dashboard has no current blockers.",
      counts: {
        controls: totalControls,
        readyControls,
        pendingApprovals,
        readinessGaps,
        completedDecisions,
        suppressedCompletedDecisions,
        openRemediations: docs.openRemediations.length,
        claimsNeedingEvidence: docs.claimsNeedingEvidence.length,
        codeScanningAlerts: codeAlerts,
        secretScanningAlerts: secretAlerts,
        securityAlerts,
      },
    },
    localDocs: docs,
    github,
  };
}

export async function dispatchSoc2DashboardResync(options: Soc2DashboardOptions = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || new Date();
  const config = repoConfig(env);
  await githubRequest<Record<string, never>>(
    fetchImpl,
    config,
    `/repos/${config.owner}/${config.repo}/actions/workflows/${encodeURIComponent(config.workflow)}/dispatches`,
    {
      method: "POST",
      body: JSON.stringify({
        ref: "main",
      }),
    },
  );

  return {
    status: "queued",
    queuedAt: now.toISOString(),
    repository: config.repository,
    workflow: config.workflow,
    workflowUrl: `https://github.com/${config.repository}/actions/workflows/${config.workflow}`,
    appImpact: APP_IMPACT,
  };
}
