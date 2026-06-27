import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  writePrivilegedAccessPrivateEvidenceKit,
} from "../scripts/soc2/privileged-access-private-evidence-kit.mjs";

function tempDirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "schoolpilot-soc2-privileged-kit-"));
  const root = path.join(base, "SchoolPilot");
  const privateDir = path.join(base, "SchoolPilot-SOC2-Evidence");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(privateDir, { recursive: true });
  return { root, privateDir };
}

function readJson(fullPath: string) {
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function writeJson(fullPath: string, record: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, `${JSON.stringify(record, null, 2)}\n`);
}

describe("SOC2-003 privileged access private evidence kit", () => {
  it("creates private draft access-review, export-template, and MFA-deferral files", async () => {
    const { root, privateDir } = tempDirs();
    const result = await writePrivilegedAccessPrivateEvidenceKit({
      rootDir: root,
      privateEvidenceDir: privateDir,
      now: new Date("2026-06-27T12:00:00Z"),
    });

    assert.equal(result.outputs.length, 3);
    for (const output of result.outputs) {
      assert.ok(fs.existsSync(output.jsonPath));
      assert.ok(fs.existsSync(output.markdownPath));
      assert.equal(readJson(output.jsonPath).status, "draft_pending_founder_input");
    }
    assert.ok(fs.existsSync(path.join(privateDir, "access-reviews", "soc2-003-privileged-access-review.json")));
    assert.ok(fs.existsSync(path.join(privateDir, "access-reviews", "exports", "soc2-003-user-role-export-template.json")));
    assert.ok(fs.existsSync(path.join(privateDir, "risk-acceptances", "soc2-003-mfa-deferral-risk-acceptance.json")));
  });

  it("fails clearly when the private evidence repo is missing", async () => {
    const { root, privateDir } = tempDirs();
    fs.rmSync(privateDir, { recursive: true, force: true });

    await assert.rejects(
      () => writePrivilegedAccessPrivateEvidenceKit({
        rootDir: root,
        privateEvidenceDir: privateDir,
        now: new Date("2026-06-27T12:00:00Z"),
      }),
      /Private evidence directory does not exist/,
    );
  });

  it("refuses to write private evidence inside the public app repo", async () => {
    const { root } = tempDirs();
    const insideRoot = path.join(root, "private-evidence");
    fs.mkdirSync(insideRoot, { recursive: true });

    await assert.rejects(
      () => writePrivilegedAccessPrivateEvidenceKit({
        rootDir: root,
        privateEvidenceDir: insideRoot,
        now: new Date("2026-06-27T12:00:00Z"),
      }),
      /Refusing to write private privileged access evidence inside the public SchoolPilot application repository/,
    );
  });

  it("refuses to overwrite completed evidence without force", async () => {
    const { root, privateDir } = tempDirs();
    const completedPath = path.join(privateDir, "access-reviews", "soc2-003-privileged-access-review.json");
    writeJson(completedPath, {
      evidenceId: "SOC2-003-PRIVILEGED-ACCESS-REVIEW",
      controlId: "SP-SEC-001",
      remediationItem: "SOC2-003",
      evidenceType: "privileged_access_review",
      status: "ready_for_approval",
    });

    await assert.rejects(
      () => writePrivilegedAccessPrivateEvidenceKit({
        rootDir: root,
        privateEvidenceDir: privateDir,
        now: new Date("2026-06-27T12:00:00Z"),
      }),
      /Refusing to overwrite non-draft privileged access evidence/,
    );
  });

  it("requires DATABASE_URL for explicit database export mode", async () => {
    const { root, privateDir } = tempDirs();
    const previousDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    try {
      await assert.rejects(
        () => writePrivilegedAccessPrivateEvidenceKit({
          rootDir: root,
          privateEvidenceDir: privateDir,
          fromDatabase: true,
          now: new Date("2026-06-27T12:00:00Z"),
        }),
        /--from-database requires DATABASE_URL/,
      );
    } finally {
      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
    }
  });
});
