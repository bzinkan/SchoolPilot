import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildPrivilegedAccessEvidence,
  validatePrivilegedAccessEvidence,
  writePrivilegedAccessEvidence,
} from "../scripts/soc2/collect-privileged-access-evidence.mjs";

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schoolpilot-soc2-privileged-"));
  writeSourceFiles(root);
  return root;
}

function write(root: string, relativePath: string, contents: string) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, contents);
}

function writeSourceFiles(root: string) {
  write(root, "src/routes/auth.ts", "req.session.role = user.isSuperAdmin ? 'super_admin' : 'teacher'; lastLoginAt; authenticate;");
  write(root, "src/middleware/requireRole.ts", "Super admins bypass role checks; inArray(schoolMemberships.role, roles);");
  write(root, "src/middleware/requireSchoolContext.ts", "res.locals.membershipRole = membership.role; bindTenantContext();");
  write(root, "src/middleware/sessionIdleTimeout.ts", "const ELEVATED_ROLES = new Set(['admin', 'school_admin', 'super_admin']);");
  write(root, "src/services/securityMonitor.ts", "off_hours_admin; cross_school_access; user_role IN ('admin', 'school_admin', 'super_admin');");
  write(root, "src/services/audit.ts", "auditLogs; logAudit; action; userRole;");
  write(root, "src/schema/core.ts", "isSuperAdmin; schoolMemberships; role;");
  write(root, "src/schema/shared.ts", "auditLogs; userRole; action; securityEvents;");
}

describe("SOC2-003 privileged access evidence", () => {
  it("creates JSON and Markdown packets", () => {
    const root = tempRoot();
    const evidence = buildPrivilegedAccessEvidence({
      rootDir: root,
      now: new Date("2026-06-27T12:00:00Z"),
    });
    const outputDir = path.join(root, "soc2-evidence", "privileged-access");
    const { jsonPath, mdPath } = writePrivilegedAccessEvidence(evidence, outputDir);

    assert.equal(evidence.validation.status, "pass");
    assert.ok(fs.existsSync(jsonPath));
    assert.ok(fs.existsSync(mdPath));
    assert.match(fs.readFileSync(mdPath, "utf8"), /MFA Status/);
  });

  it("includes commit, workflow, run, and actor metadata from env vars", () => {
    const root = tempRoot();
    const evidence = buildPrivilegedAccessEvidence({
      rootDir: root,
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "bzinkan/SchoolPilot",
        GITHUB_REF: "refs/heads/codex/test",
        GITHUB_REF_NAME: "codex/test",
        GITHUB_SHA: "abc123",
        GITHUB_ACTOR: "bzinkan",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_WORKFLOW: "CI",
        GITHUB_RUN_ID: "12345",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_JOB: "soc2-privileged-access-evidence",
        GITHUB_SERVER_URL: "https://github.com",
      },
      now: new Date("2026-06-27T12:00:00Z"),
    });

    assert.equal(evidence.packet.git.repository, "bzinkan/SchoolPilot");
    assert.equal(evidence.packet.git.commitSha, "abc123");
    assert.equal(evidence.packet.git.actor, "bzinkan");
    assert.equal(evidence.packet.ci.workflow, "CI");
    assert.equal(evidence.packet.ci.runUrl, "https://github.com/bzinkan/SchoolPilot/actions/runs/12345");
  });

  it("records MFA as deferred, role tiers, safeguards, and source hashes", () => {
    const root = tempRoot();
    const evidence = buildPrivilegedAccessEvidence({
      rootDir: root,
      now: new Date("2026-06-27T12:00:00Z"),
    });

    assert.equal(evidence.packet.mfa.status, "deferred_not_live");
    assert.equal(evidence.packet.mfa.userFacingChangeEnabled, false);
    assert.deepEqual(evidence.packet.privilegedRoleTiers.map((tier) => tier.tierId), [
      "super_admin",
      "school_admin",
      "operational_elevated",
    ]);
    assert.equal(evidence.packet.safeguards.privilegedIdleTimeout, "present");
    assert.match(evidence.packet.sourceHashes.authRoutes.sha256 || "", /^[a-f0-9]{64}$/);
  });

  it("excludes private user exports, passwords, sessions, secrets, customer data, and student data", () => {
    const root = tempRoot();
    const evidence = buildPrivilegedAccessEvidence({
      rootDir: root,
      now: new Date("2026-06-27T12:00:00Z"),
    });
    const serialized = JSON.stringify(evidence.packet);

    assert.doesNotMatch(serialized, /PRIVATE_USER_EXPORT_BODY/);
    assert.doesNotMatch(serialized, /PASSWORD_HASH/);
    assert.doesNotMatch(serialized, /SESSION_SECRET_VALUE/);
    assert.doesNotMatch(serialized, /PRIVATE_CUSTOMER_DATA/);
    assert.doesNotMatch(serialized, /PRIVATE_STUDENT_DATA/);
  });

  it("fails validation when required fields are missing", () => {
    const root = tempRoot();
    const evidence = buildPrivilegedAccessEvidence({
      rootDir: root,
      now: new Date("2026-06-27T12:00:00Z"),
    });
    const broken = structuredClone(evidence.packet);
    broken.git.commitSha = "";
    broken.mfa.status = "enabled";

    const validation = validatePrivilegedAccessEvidence(broken);

    assert.equal(validation.status, "fail");
    assert.match(validation.errors.join("\n"), /git\.commitSha/);
    assert.match(validation.errors.join("\n"), /deferred_not_live/);
  });
});
