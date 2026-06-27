import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  writeAiPrivateEvidenceKit,
} from "../scripts/soc2/ai-private-evidence-kit.mjs";

function tempRoot() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "schoolpilot-soc2-ai-kit-"));
  const root = path.join(workspace, "SchoolPilot");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(workspace, "SchoolPilot-SOC2-Evidence"), { recursive: true });
  return root;
}

function privateDir(root: string) {
  return path.resolve(root, "..", "SchoolPilot-SOC2-Evidence");
}

describe("SOC2-002 private AI evidence kit", () => {
  it("creates the private JSON and Markdown draft files", () => {
    const root = tempRoot();
    const result = writeAiPrivateEvidenceKit({
      rootDir: root,
      privateEvidenceDir: privateDir(root),
      now: new Date("2026-06-27T12:00:00Z"),
    });

    assert.equal(result.status, "draft_pending_founder_input");
    assert.equal(result.outputs.length, 1);
    const output = result.outputs[0];
    assert.ok(fs.existsSync(output.jsonPath));
    assert.ok(fs.existsSync(output.markdownPath));
    assert.equal(output.privateJsonPath, "ai/reviews/soc2-002-ai-data-flow-review.json");

    const record = JSON.parse(fs.readFileSync(output.jsonPath, "utf8"));
    assert.equal(record.evidenceId, "SOC2-002-AI-DATA-FLOW-REVIEW");
    assert.equal(record.controlId, "SP-CONF-002");
    assert.equal(record.remediationItem, "SOC2-002");
    assert.equal(record.evidenceType, "ai_data_flow_review");
    assert.equal(record.status, "draft_pending_founder_input");
    assert.equal(record.appImpact, "No user-facing behavior changed");
    assert.equal(record.founderCompletion.readyForApproval, false);
    assert.ok(record.requiredFields.providersReviewed);
    assert.ok(record.requiredFields.publicClaimsReviewed);
    assert.ok(Array.isArray(record.checklist));
  });

  it("keeps existing draft files unless forced", () => {
    const root = tempRoot();
    const first = writeAiPrivateEvidenceKit({
      rootDir: root,
      privateEvidenceDir: privateDir(root),
      now: new Date("2026-06-27T12:00:00Z"),
    });
    const firstRecord = JSON.parse(fs.readFileSync(first.outputs[0].jsonPath, "utf8"));
    const second = writeAiPrivateEvidenceKit({
      rootDir: root,
      privateEvidenceDir: privateDir(root),
      now: new Date("2026-06-28T12:00:00Z"),
    });
    const secondRecord = JSON.parse(fs.readFileSync(first.outputs[0].jsonPath, "utf8"));

    assert.equal(second.outputs.every((output) => output.skipped), true);
    assert.equal(secondRecord.generatedAt, firstRecord.generatedAt);
  });

  it("fails clearly when the private evidence repo is missing", () => {
    const root = tempRoot();

    assert.throws(
      () => writeAiPrivateEvidenceKit({
        rootDir: root,
        privateEvidenceDir: path.join(root, "missing-private-repo"),
      }),
      /Private evidence directory does not exist/,
    );
  });

  it("refuses to write private evidence into the public app repo", () => {
    const root = tempRoot();

    assert.throws(
      () => writeAiPrivateEvidenceKit({
        rootDir: root,
        privateEvidenceDir: root,
      }),
      /Refusing to write private AI evidence inside the public SchoolPilot application repository/,
    );
  });

  it("refuses to overwrite completed evidence unless forced", () => {
    const root = tempRoot();
    const completedPath = path.join(privateDir(root), "ai", "reviews", "soc2-002-ai-data-flow-review.json");
    fs.mkdirSync(path.dirname(completedPath), { recursive: true });
    fs.writeFileSync(
      completedPath,
      `${JSON.stringify({
        evidenceId: "SOC2-002-AI-DATA-FLOW-REVIEW",
        controlId: "SP-CONF-002",
        remediationItem: "SOC2-002",
        evidenceType: "ai_data_flow_review",
        status: "ready_for_approval",
      }, null, 2)}\n`,
    );

    assert.throws(
      () => writeAiPrivateEvidenceKit({
        rootDir: root,
        privateEvidenceDir: privateDir(root),
      }),
      /Refusing to overwrite non-draft AI evidence/,
    );
  });
});
