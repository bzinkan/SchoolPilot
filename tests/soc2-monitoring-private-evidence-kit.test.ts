import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  writeMonitoringPrivateEvidenceKit,
} from "../scripts/soc2/monitoring-private-evidence-kit.mjs";

function tempRoot() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "schoolpilot-soc2-monitoring-kit-"));
  const root = path.join(workspace, "SchoolPilot");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(workspace, "SchoolPilot-SOC2-Evidence"), { recursive: true });
  return root;
}

function privateDir(root: string) {
  return path.resolve(root, "..", "SchoolPilot-SOC2-Evidence");
}

describe("SOC 2 monitoring private evidence kit", () => {
  it("creates private JSON and Markdown draft files for monitoring and alert reviews", () => {
    const root = tempRoot();
    const result = writeMonitoringPrivateEvidenceKit({
      rootDir: root,
      privateEvidenceDir: privateDir(root),
      now: new Date("2026-06-28T12:00:00Z"),
    });

    assert.equal(result.status, "draft_pending_founder_input");
    assert.equal(result.outputs.length, 2);
    const paths = result.outputs.map((output) => output.privateJsonPath).sort();
    assert.deepEqual(paths, [
      "monitoring/reviews/soc2-monthly-monitoring-review.json",
      "security-events/reviews/soc2-monthly-alert-review.json",
    ]);

    for (const output of result.outputs) {
      assert.ok(fs.existsSync(output.jsonPath));
      assert.ok(fs.existsSync(output.markdownPath));
      const record = JSON.parse(fs.readFileSync(output.jsonPath, "utf8"));
      assert.equal(record.status, "draft_pending_founder_input");
      assert.equal(record.appImpact, "No user-facing behavior changed");
      assert.equal(record.founderCompletion.readyForApproval, false);
      assert.equal(record.reviewMonth, "2026-06");
      assert.ok(Array.isArray(record.checklist));
      assert.ok(record.requiredFields);
    }
  });

  it("keeps existing draft files unless forced", () => {
    const root = tempRoot();
    const first = writeMonitoringPrivateEvidenceKit({
      rootDir: root,
      privateEvidenceDir: privateDir(root),
      now: new Date("2026-06-28T12:00:00Z"),
    });
    const firstRecord = JSON.parse(fs.readFileSync(first.outputs[0].jsonPath, "utf8"));
    const second = writeMonitoringPrivateEvidenceKit({
      rootDir: root,
      privateEvidenceDir: privateDir(root),
      now: new Date("2026-07-01T12:00:00Z"),
    });
    const secondRecord = JSON.parse(fs.readFileSync(first.outputs[0].jsonPath, "utf8"));

    assert.equal(second.outputs.every((output) => output.skipped), true);
    assert.equal(secondRecord.generatedAt, firstRecord.generatedAt);
  });

  it("fails clearly when the private evidence repo is missing", () => {
    const root = tempRoot();

    assert.throws(
      () => writeMonitoringPrivateEvidenceKit({
        rootDir: root,
        privateEvidenceDir: path.join(root, "missing-private-repo"),
      }),
      /Private evidence directory does not exist/,
    );
  });

  it("refuses to write private evidence into the public app repo", () => {
    const root = tempRoot();

    assert.throws(
      () => writeMonitoringPrivateEvidenceKit({
        rootDir: root,
        privateEvidenceDir: root,
      }),
      /Refusing to write private monitoring evidence inside the public SchoolPilot application repository/,
    );
  });

  it("refuses to overwrite completed monitoring evidence unless forced", () => {
    const root = tempRoot();
    const completedPath = path.join(privateDir(root), "monitoring", "reviews", "soc2-monthly-monitoring-review.json");
    fs.mkdirSync(path.dirname(completedPath), { recursive: true });
    fs.writeFileSync(
      completedPath,
      `${JSON.stringify({
        evidenceId: "SOC2-MONTHLY-MONITORING-REVIEW",
        controlId: "SP-AVL-002",
        evidenceType: "monthly_monitoring_review",
        status: "ready_for_approval",
      }, null, 2)}\n`,
    );

    assert.throws(
      () => writeMonitoringPrivateEvidenceKit({
        rootDir: root,
        privateEvidenceDir: privateDir(root),
      }),
      /Refusing to overwrite non-draft monitoring evidence/,
    );
  });
});
