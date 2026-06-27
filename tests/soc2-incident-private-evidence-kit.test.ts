import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  writeIncidentPrivateEvidenceKit,
} from "../scripts/soc2/incident-private-evidence-kit.mjs";

function tempRoot() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "schoolpilot-soc2-incident-kit-"));
  const root = path.join(workspace, "SchoolPilot");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(workspace, "SchoolPilot-SOC2-Evidence"), { recursive: true });
  return root;
}

function privateDir(root: string) {
  return path.resolve(root, "..", "SchoolPilot-SOC2-Evidence");
}

describe("SOC2-001 private incident evidence kit", () => {
  it("creates the three private JSON and Markdown draft files", () => {
    const root = tempRoot();
    const result = writeIncidentPrivateEvidenceKit({
      rootDir: root,
      privateEvidenceDir: privateDir(root),
      now: new Date("2026-06-27T12:00:00Z"),
    });

    assert.equal(result.status, "draft_pending_founder_input");
    assert.equal(result.outputs.length, 3);
    for (const output of result.outputs) {
      assert.ok(fs.existsSync(output.jsonPath));
      assert.ok(fs.existsSync(output.markdownPath));
      assert.match(output.privateJsonPath, /^incidents\//);
      const record = JSON.parse(fs.readFileSync(output.jsonPath, "utf8"));
      assert.equal(record.incidentId, "SOC2-001-HISTORICAL-CREDENTIAL-EXPOSURE");
      assert.equal(record.status, "draft_pending_founder_input");
      assert.equal(record.appImpact, "No user-facing behavior changed");
      assert.equal(record.founderCompletion.readyForApproval, false);
      assert.ok(record.requiredFields);
      assert.ok(Array.isArray(record.checklist));
    }
  });

  it("keeps existing draft files unless forced", () => {
    const root = tempRoot();
    const first = writeIncidentPrivateEvidenceKit({
      rootDir: root,
      privateEvidenceDir: privateDir(root),
      now: new Date("2026-06-27T12:00:00Z"),
    });
    const firstRecord = JSON.parse(fs.readFileSync(first.outputs[0].jsonPath, "utf8"));
    const second = writeIncidentPrivateEvidenceKit({
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
      () => writeIncidentPrivateEvidenceKit({
        rootDir: root,
        privateEvidenceDir: path.join(root, "missing-private-repo"),
      }),
      /Private evidence directory does not exist/,
    );
  });

  it("refuses to write private evidence into the public app repo", () => {
    const root = tempRoot();

    assert.throws(
      () => writeIncidentPrivateEvidenceKit({
        rootDir: root,
        privateEvidenceDir: root,
      }),
      /Refusing to write private incident evidence inside the public SchoolPilot application repository/,
    );
  });

  it("refuses to overwrite completed evidence unless forced", () => {
    const root = tempRoot();
    const completedPath = path.join(privateDir(root), "incidents", "credential-rotation", "soc2-001-credential-rotation.json");
    fs.mkdirSync(path.dirname(completedPath), { recursive: true });
    fs.writeFileSync(
      completedPath,
      `${JSON.stringify({
        incidentId: "SOC2-001-HISTORICAL-CREDENTIAL-EXPOSURE",
        evidenceType: "credential_rotation",
        status: "ready_for_approval",
      }, null, 2)}\n`,
    );

    assert.throws(
      () => writeIncidentPrivateEvidenceKit({
        rootDir: root,
        privateEvidenceDir: privateDir(root),
      }),
      /Refusing to overwrite non-draft incident evidence/,
    );
  });
});
