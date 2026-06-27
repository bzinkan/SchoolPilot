import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildIncidentEvidence,
  validateIncidentEvidence,
  writeIncidentEvidence,
} from "../scripts/soc2/collect-incident-evidence.mjs";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "schoolpilot-soc2-incident-"));
}

function githubEnv() {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "bzinkan/SchoolPilot",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_WORKFLOW: "CI",
    GITHUB_RUN_ID: "123456",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_JOB: "soc2-incident-evidence",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REF_NAME: "main",
    GITHUB_SHA: "abc123",
    GITHUB_ACTOR: "bzinkan",
    GITHUB_EVENT_NAME: "push",
    JOB_STATUS: "success",
  };
}

describe("SOC 2 incident evidence", () => {
  it("creates JSON and Markdown incident packets", () => {
    const root = tempRoot();
    const evidence = buildIncidentEvidence({
      rootDir: root,
      env: githubEnv(),
      now: new Date("2026-06-26T12:00:00Z"),
    });
    const outputDir = path.join(root, "soc2-evidence", "incidents");
    const { jsonPath, mdPath } = writeIncidentEvidence(evidence, outputDir);

    assert.equal(evidence.validation.status, "pass");
    assert.match(jsonPath, /soc2-001-historical-credential-exposure-incident-evidence\.json$/);
    assert.ok(fs.existsSync(jsonPath));
    assert.ok(fs.existsSync(mdPath));
    assert.match(fs.readFileSync(mdPath, "utf8"), /SOC 2 Incident Evidence/);
  });

  it("includes commit, workflow, run, and actor metadata from env vars", () => {
    const root = tempRoot();
    const { packet } = buildIncidentEvidence({
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

  it("preserves no-user-impact and pending human decisions", () => {
    const root = tempRoot();
    const { packet } = buildIncidentEvidence({
      rootDir: root,
      env: githubEnv(),
      now: new Date("2026-06-26T12:00:00Z"),
    });

    assert.equal(packet.appImpact, "No user-facing behavior changed");
    assert.equal(packet.humanDecisions.closure.status, "pending_human_approval");
    assert.equal(packet.humanDecisions.notification.status, "pending_human_approval");
    assert.equal(packet.exposureAssessment.status, "pending_human_assessment");
  });

  it("includes only pointers to private evidence without copying private contents", () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, "private"), { recursive: true });
    fs.writeFileSync(path.join(root, "private", "incident-notes.txt"), "PRIVATE_INCIDENT_DETAIL_BODY");

    const evidence = buildIncidentEvidence({
      rootDir: root,
      env: githubEnv(),
      now: new Date("2026-06-26T12:00:00Z"),
    });
    const { jsonPath, mdPath } = writeIncidentEvidence(evidence, path.join(root, "soc2-evidence", "incidents"));
    const serialized = `${fs.readFileSync(jsonPath, "utf8")}\n${fs.readFileSync(mdPath, "utf8")}`;

    assert.doesNotMatch(serialized, /PRIVATE_INCIDENT_DETAIL_BODY/);
    assert.match(serialized, /SchoolPilot-SOC2-Evidence\/incidents/);
    assert.match(serialized, /credential-rotation/);
    assert.match(serialized, /log-review/);
  });

  it("fails validation when required fields are missing", () => {
    const root = tempRoot();
    const { packet } = buildIncidentEvidence({
      rootDir: root,
      env: githubEnv(),
      now: new Date("2026-06-26T12:00:00Z"),
    });
    const broken = structuredClone(packet);
    broken.git.commitSha = "";
    broken.humanDecisions.notification.status = "approved";

    const validation = validateIncidentEvidence(broken);

    assert.equal(validation.status, "fail");
    assert.match(validation.errors.join("\n"), /git\.commitSha/);
    assert.match(validation.errors.join("\n"), /Notification decision must remain pending human approval/);
  });
});
