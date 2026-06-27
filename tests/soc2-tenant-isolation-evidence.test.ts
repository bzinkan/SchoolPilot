import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildTenantIsolationEvidence,
  validateTenantIsolationEvidence,
  writeTenantIsolationEvidence,
} from "../scripts/soc2/collect-tenant-isolation-evidence.mjs";

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schoolpilot-soc2-tenant-"));
  for (const relativePath of [
    "src/db/rlsPolicies.ts",
    "src/middleware/tenantContext.ts",
    "tests/cross-tenant-isolation.test.ts",
    "tests/rls-policy.test.ts",
    "tests/rls-tenant-context.test.ts",
    "tests/setup-rls-ci.ts",
  ]) {
    const fullPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, `// ${relativePath}\n`);
  }
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".github", "workflows", "ci-build.yml"),
    "env:\n  RLS_ENABLED_TABLES: students,groups,devices\n",
  );
  return root;
}

function githubEnv(overrides: Record<string, string> = {}) {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "bzinkan/SchoolPilot",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_WORKFLOW: "CI",
    GITHUB_RUN_ID: "123456",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_JOB: "soc2-tenant-isolation-evidence",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REF_NAME: "main",
    GITHUB_SHA: "abc123",
    GITHUB_ACTOR: "bzinkan",
    GITHUB_EVENT_NAME: "push",
    JOB_STATUS: "success",
    ...overrides,
  };
}

describe("SOC 2 tenant isolation evidence", () => {
  it("creates JSON and Markdown tenant isolation packets", () => {
    const root = tempRoot();
    const evidence = buildTenantIsolationEvidence({
      rootDir: root,
      env: githubEnv(),
      now: new Date("2026-06-26T12:00:00Z"),
    });
    const outputDir = path.join(root, "soc2-evidence", "tenant-isolation");
    const { jsonPath, mdPath } = writeTenantIsolationEvidence(evidence, outputDir);

    assert.equal(evidence.validation.status, "pass");
    assert.match(jsonPath, /tenant-isolation-evidence\.json$/);
    assert.ok(fs.existsSync(jsonPath));
    assert.ok(fs.existsSync(mdPath));
    assert.match(fs.readFileSync(mdPath, "utf8"), /SOC 2 Tenant Isolation Evidence/);
  });

  it("includes commit, workflow, run, and actor metadata", () => {
    const root = tempRoot();
    const { packet } = buildTenantIsolationEvidence({
      rootDir: root,
      env: githubEnv(),
      now: new Date("2026-06-26T12:00:00Z"),
    });

    assert.equal(packet.git.repository, "bzinkan/SchoolPilot");
    assert.equal(packet.git.ref, "refs/heads/main");
    assert.equal(packet.git.branch, "main");
    assert.equal(packet.git.commitSha, "abc123");
    assert.equal(packet.git.actor, "bzinkan");
    assert.equal(packet.ci.workflow, "CI");
    assert.equal(packet.ci.runUrl, "https://github.com/bzinkan/SchoolPilot/actions/runs/123456");
  });

  it("captures RLS allowlist from env vars and optional flags", () => {
    const root = tempRoot();
    const fromEnv = buildTenantIsolationEvidence({
      rootDir: root,
      env: githubEnv({ RLS_ENABLED_TABLES: "students,devices" }),
      now: new Date("2026-06-26T12:00:00Z"),
    }).packet;
    const fromFlag = buildTenantIsolationEvidence({
      rootDir: root,
      env: githubEnv({ RLS_ENABLED_TABLES: "students,devices" }),
      rlsEnabledTables: "passes,students",
      now: new Date("2026-06-26T12:00:00Z"),
    }).packet;

    assert.deepEqual(fromEnv.rls.enabledTables, ["devices", "students"]);
    assert.equal(fromEnv.rls.allowlistSource, "env");
    assert.deepEqual(fromFlag.rls.enabledTables, ["passes", "students"]);
    assert.equal(fromFlag.rls.allowlistSource, "cli");
  });

  it("hashes expected RLS policy and test source files", () => {
    const root = tempRoot();
    const { packet } = buildTenantIsolationEvidence({
      rootDir: root,
      env: githubEnv(),
      now: new Date("2026-06-26T12:00:00Z"),
    });

    assert.match(packet.fileHashes.rlsPolicies.sha256 || "", /^[a-f0-9]{64}$/);
    assert.match(packet.fileHashes.crossTenantTests.sha256 || "", /^[a-f0-9]{64}$/);
    assert.match(packet.fileHashes.rlsCiSetup.sha256 || "", /^[a-f0-9]{64}$/);
  });

  it("references CI artifacts and keeps production exports private", () => {
    const root = tempRoot();
    const { packet } = buildTenantIsolationEvidence({
      rootDir: root,
      env: githubEnv(),
      now: new Date("2026-06-26T12:00:00Z"),
    });

    assert.equal(packet.ci.evidenceArtifacts.crossTenantTests, "soc2-evidence-cross-tenant");
    assert.equal(packet.ci.evidenceArtifacts.rlsEnabledTests, "soc2-evidence-rls-enabled");
    assert.equal(packet.rls.productionStatusExport, "pending_private_export");
    assert.equal(packet.rls.dbGrantsAndPoliciesExport, "pending_private_export");
    assert.equal(packet.appImpact, "No user-facing behavior changed");
    assert.equal(packet.humanReview.status, "pending_human_approval");
  });

  it("fails validation when required metadata is missing", () => {
    const root = tempRoot();
    const { packet } = buildTenantIsolationEvidence({
      rootDir: root,
      env: githubEnv(),
      now: new Date("2026-06-26T12:00:00Z"),
    });
    const broken = structuredClone(packet);
    broken.git.commitSha = "";
    broken.rls.enabledTables = [];
    broken.rls.productionStatusExport = "copied_export";

    const validation = validateTenantIsolationEvidence(broken);

    assert.equal(validation.status, "fail");
    assert.match(validation.errors.join("\n"), /git\.commitSha/);
    assert.match(validation.errors.join("\n"), /rls\.enabledTables/);
    assert.match(validation.errors.join("\n"), /Production RLS status export must remain a private evidence pointer/);
  });
});
