import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildDeploymentEvidence,
  validateDeploymentEvidence,
  writeDeploymentEvidence,
} from "../scripts/soc2/collect-deployment-evidence.mjs";

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schoolpilot-deploy-evidence-"));
  write(root, "package-lock.json", '{"name":"api","secret":"super-secret-token"}\n');
  write(root, "schoolpilot-app/package-lock.json", '{"name":"frontend"}\n');
  write(root, "Dockerfile", "FROM node:22\n");
  write(root, "scripts/deploy.sh", "#!/bin/bash\necho deploy\n");
  return root;
}

function write(root: string, relativePath: string, contents: string) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, contents);
}

function githubEnv(root: string) {
  const eventPath = path.join(root, "event.json");
  fs.writeFileSync(
    eventPath,
    JSON.stringify({
      pull_request: {
        number: 140,
        html_url: "https://github.com/bzinkan/SchoolPilot/pull/140",
      },
    }),
  );

  return {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "bzinkan/SchoolPilot",
    GITHUB_REF: "refs/pull/140/merge",
    GITHUB_HEAD_REF: "codex/soc2-shadow-deployment-evidence",
    GITHUB_SHA: "abc123def456",
    GITHUB_ACTOR: "bzinkan",
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_WORKFLOW: "CI",
    GITHUB_JOB: "soc2-deployment-evidence",
    GITHUB_RUN_ID: "12345",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SERVER_URL: "https://github.com",
    JOB_STATUS: "success",
    CI_JOB_RESULTS: JSON.stringify({
      backend: { result: "success" },
      frontend: { result: "success" },
    }),
  };
}

describe("SOC 2 deployment evidence", () => {
  it("creates JSON and Markdown deployment evidence packets", () => {
    const root = tempRoot();
    const outputDir = path.join(root, "soc2-evidence", "deployments");
    const evidence = buildDeploymentEvidence({
      rootDir: root,
      env: githubEnv(root),
      now: new Date("2026-06-26T12:00:00Z"),
    });

    const paths = writeDeploymentEvidence(evidence, outputDir);

    assert.equal(evidence.validation.status, "pass");
    assert.equal(fs.existsSync(paths.jsonPath), true);
    assert.equal(fs.existsSync(paths.mdPath), true);
    assert.match(paths.jsonPath, /shadow-deployment-evidence\.json$/);
    assert.match(fs.readFileSync(paths.mdPath, "utf8"), /SOC 2 Shadow Deployment Evidence/);
  });

  it("includes GitHub workflow and PR metadata when available", () => {
    const root = tempRoot();
    const { packet } = buildDeploymentEvidence({
      rootDir: root,
      env: githubEnv(root),
      now: new Date("2026-06-26T12:00:00Z"),
    });

    assert.equal(packet.git.repository, "bzinkan/SchoolPilot");
    assert.equal(packet.git.branch, "codex/soc2-shadow-deployment-evidence");
    assert.equal(packet.git.commitSha, "abc123def456");
    assert.equal(packet.git.pullRequest.number, "140");
    assert.equal(packet.git.pullRequest.url, "https://github.com/bzinkan/SchoolPilot/pull/140");
    assert.equal(packet.ci.workflow, "CI");
    assert.equal(packet.ci.runUrl, "https://github.com/bzinkan/SchoolPilot/actions/runs/12345");
    assert.deepEqual(packet.ci.jobResults, [
      { job: "backend", result: "success" },
      { job: "frontend", result: "success" },
    ]);
  });

  it("hashes expected files without copying file contents or secrets", () => {
    const root = tempRoot();
    const { packet } = buildDeploymentEvidence({
      rootDir: root,
      env: githubEnv(root),
      now: new Date("2026-06-26T12:00:00Z"),
    });
    const serialized = JSON.stringify(packet);

    assert.match(packet.fileHashes.backendPackageLock.sha256 || "", /^[a-f0-9]{64}$/);
    assert.match(packet.fileHashes.frontendPackageLock.sha256 || "", /^[a-f0-9]{64}$/);
    assert.match(packet.fileHashes.dockerfile.sha256 || "", /^[a-f0-9]{64}$/);
    assert.match(packet.fileHashes.deployScript.sha256 || "", /^[a-f0-9]{64}$/);
    assert.equal(serialized.includes("super-secret-token"), false);
    assert.equal(serialized.includes("FROM node:22"), false);
  });

  it("marks production deploy as not requested and pending human approval", () => {
    const root = tempRoot();
    const { packet } = buildDeploymentEvidence({
      rootDir: root,
      env: githubEnv(root),
      now: new Date("2026-06-26T12:00:00Z"),
    });

    assert.equal(packet.appImpact, "No user-facing behavior changed");
    assert.equal(packet.deployment.imageDigest, "pending/not_deployed");
    assert.equal(packet.deployment.productionDeployDecision, "not_requested");
    assert.equal(packet.deployment.productionApprovalStatus, "pending_human_approval");
    assert.equal(packet.deployment.awsCredentialsRequired, false);
    assert.equal(packet.deployment.awsActionsPerformed, false);
  });

  it("fails validation if required metadata is missing", () => {
    const root = tempRoot();
    const { packet } = buildDeploymentEvidence({
      rootDir: root,
      env: githubEnv(root),
      now: new Date("2026-06-26T12:00:00Z"),
    });

    const result = validateDeploymentEvidence({
      ...packet,
      git: {
        ...packet.git,
        repository: "",
      },
    });

    assert.equal(result.status, "fail");
    assert.match(result.errors.join("\n"), /git\.repository/);
  });
});
