#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_IMPACT = "No user-facing behavior changed";
const DRAFT_STATUS = "draft_pending_founder_input";
const READY_STATUS = "ready_for_approval";

function argValue(name, fallback = "") {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env[name.toUpperCase().replace(/-/g, "_")] || fallback;
}

function argEnabled(name) {
  return process.argv.includes(`--${name}`);
}

function parseJsonFile(fullPath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(fullPath, "utf8"));
  } catch {
    return fallback;
  }
}

function privateEvidenceRelativePath(privateEvidenceDir, fullPath) {
  return path.relative(privateEvidenceDir, fullPath).replace(/\\/g, "/");
}

function assertPrivateEvidenceTarget(rootDir, privateEvidenceDir) {
  if (!fs.existsSync(privateEvidenceDir)) {
    throw new Error(`Private evidence directory does not exist: ${privateEvidenceDir}`);
  }

  const resolvedRoot = path.resolve(rootDir);
  const resolvedPrivate = path.resolve(privateEvidenceDir);
  const relative = path.relative(resolvedRoot, resolvedPrivate);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("Refusing to write private privileged access evidence inside the public SchoolPilot application repository.");
  }
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function buildAccessReviewRecord({ generatedAt }) {
  return {
    evidenceId: "SOC2-003-PRIVILEGED-ACCESS-REVIEW",
    controlId: "SP-SEC-001",
    remediationItem: "SOC2-003",
    evidenceType: "privileged_access_review",
    title: "SOC2-003 privileged access review",
    status: DRAFT_STATUS,
    generatedAt,
    appImpact: APP_IMPACT,
    owner: "Security & Privacy Officer",
    completionInstructions: [
      "Complete all TODO fields with factual privileged access review conclusions.",
      "Do not paste passwords, password hashes, session contents, secret values, customer records, or student records.",
      `Set status to ${READY_STATUS} only after the founder/security owner verifies the review is complete.`,
    ],
    requiredFields: {
      reviewPeriodStart: "TODO",
      reviewPeriodEnd: "TODO",
      reviewerName: "TODO",
      systemsReviewed: [
        "SchoolPilot super-admin accounts",
        "SchoolPilot school admin / school_admin memberships",
        "SchoolPilot office_staff operational elevated memberships",
        "GitHub admin/maintainer access",
        "AWS/IAM and production console access",
        "Database/admin tooling access",
      ],
      userRoleExportPointer: "SchoolPilot-SOC2-Evidence/access-reviews/exports/soc2-003-user-role-export-template.json",
      exceptions: [
        {
          userOrSystem: "TODO",
          exception: "TODO or none",
          decision: "TODO approve | remove | investigate",
          remediationOwner: "TODO",
          dueDate: "TODO",
        },
      ],
      conclusion: "TODO approve_current_access | not_approved",
    },
    mfaStatus: {
      currentStatus: "deferred_not_live",
      rolloutDecisionPointer: "SchoolPilot-SOC2-Evidence/risk-acceptances/soc2-003-mfa-deferral-risk-acceptance.json",
    },
    checklist: [
      "Review active super-admin users.",
      "Review active admin and school_admin memberships.",
      "Review active office_staff memberships for operational elevation.",
      "Confirm access is founder-approved or record exceptions.",
      "Confirm privileged session idle timeout and audit/security-event safeguards remain in place.",
      "Confirm MFA remains deferred and claims remain partial/deferred until rollout.",
    ],
    founderCompletion: {
      completedBy: "TODO",
      completedAt: "TODO",
      readyForApproval: false,
    },
    sensitiveDataHandling: "This private record may contain access review conclusions and evidence pointers. Do not paste passwords, password hashes, session contents, active secrets, customer records, or student records.",
  };
}

function buildUserRoleExportTemplateRecord({ generatedAt }) {
  return {
    evidenceId: "SOC2-003-USER-ROLE-EXPORT",
    controlId: "SP-SEC-001",
    remediationItem: "SOC2-003",
    evidenceType: "user_role_export",
    title: "SOC2-003 user and role export template",
    status: DRAFT_STATUS,
    generatedAt,
    appImpact: APP_IMPACT,
    owner: "Security & Privacy Officer",
    exportMode: "template_pending_private_export",
    completionInstructions: [
      "Replace TODO fields with a private privileged user/role export or rerun with --from-database from a trusted environment.",
      "Do not commit this record to the public SchoolPilot app repository.",
      `Set status to ${READY_STATUS} only after the export has been completed and reviewed.`,
    ],
    requiredFields: {
      generatedBy: "TODO",
      generatedAt: "TODO",
      sourceDatabase: "TODO production | staging | manual",
      privilegedRoleTiersIncluded: ["super_admin", "admin", "school_admin", "office_staff"],
      exportSummary: {
        superAdminCount: "TODO",
        adminMembershipCount: "TODO",
        schoolAdminMembershipCount: "TODO",
        officeStaffMembershipCount: "TODO",
      },
      exportLocation: "SchoolPilot-SOC2-Evidence/access-reviews/exports/",
    },
    sensitiveDataHandling: "Private user emails and role assignments may be stored here. Never include passwords, password hashes, session contents, OAuth tokens, API keys, customer records, or student records.",
  };
}

function buildMfaDeferralRecord({ generatedAt, expiresAt }) {
  return {
    evidenceId: "SOC2-003-MFA-DEFERRAL-RISK-ACCEPTANCE",
    approvalId: "APPROVAL-SP-SEC-001-PRIVILEGED-MFA-ROLLOUT-DECISION",
    controlId: "SP-SEC-001",
    remediationItem: "SOC2-003",
    evidenceType: "mfa_deferral_risk_acceptance",
    decisionType: "risk_acceptance",
    title: "SOC2-003 privileged MFA deferral risk acceptance",
    status: DRAFT_STATUS,
    generatedAt,
    expiresAt,
    appImpact: APP_IMPACT,
    owner: "Security & Privacy Officer",
    approverRole: "Management",
    riskStatement: "Privileged MFA is not live yet. Until rollout, privileged access is reviewed, approved, logged, and risk-accepted.",
    compensatingControls: [
      "Manual privileged access review.",
      "Founder-approved access only.",
      "Tighter idle timeout for elevated session roles.",
      "Audit logs capture user role and action metadata.",
      "Security monitor detects off-hours admin bursts and cross-school access patterns.",
      "Public MFA claims remain partial/deferred until implementation.",
    ],
    completionInstructions: [
      "Complete the access review before approving this risk acceptance.",
      "Approve only if the temporary MFA deferral is acceptable for the observation window.",
      "Replace this acceptance with operating MFA evidence once MFA is implemented.",
    ],
    founderCompletion: {
      completedBy: "TODO",
      completedAt: "TODO",
      readyForApproval: false,
    },
  };
}

async function buildUserRoleExportFromDatabase({ generatedAt }) {
  if (!process.env.DATABASE_URL) {
    throw new Error("--from-database requires DATABASE_URL to be intentionally set in the current environment.");
  }

  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    idleTimeoutMillis: 1000,
    connectionTimeoutMillis: 5000,
  });

  try {
    const result = await pool.query(`
      SELECT
        u.id AS user_id,
        u.email,
        u.is_super_admin,
        u.last_login_at,
        u.created_at AS user_created_at,
        sm.id AS membership_id,
        sm.school_id,
        s.name AS school_name,
        sm.role,
        sm.status,
        sm.gopilot_role,
        sm.created_at AS membership_created_at
      FROM users u
      LEFT JOIN school_memberships sm
        ON sm.user_id = u.id AND sm.status = 'active'
      LEFT JOIN schools s
        ON s.id = sm.school_id
      WHERE u.is_super_admin = true
         OR sm.role IN ('admin', 'school_admin', 'office_staff')
      ORDER BY u.email, sm.school_id, sm.role
    `);

    const rows = result.rows.map((row) => ({
      userId: row.user_id,
      email: row.email,
      isSuperAdmin: !!row.is_super_admin,
      lastLoginAt: row.last_login_at,
      userCreatedAt: row.user_created_at,
      membershipId: row.membership_id,
      schoolId: row.school_id,
      schoolName: row.school_name,
      role: row.role,
      status: row.status,
      gopilotRole: row.gopilot_role,
      membershipCreatedAt: row.membership_created_at,
    }));
    const count = (predicate) => rows.filter(predicate).length;

    return {
      evidenceId: "SOC2-003-USER-ROLE-EXPORT",
      controlId: "SP-SEC-001",
      remediationItem: "SOC2-003",
      evidenceType: "user_role_export",
      title: "SOC2-003 user and role export",
      status: READY_STATUS,
      generatedAt,
      appImpact: APP_IMPACT,
      owner: "Security & Privacy Officer",
      exportMode: "database_export",
      sensitiveDataBoundary: "Private privileged user emails and role assignments are stored only in the private evidence repo. Passwords, password hashes, session contents, OAuth tokens, API keys, customer records, and student records are excluded.",
      exportSummary: {
        rowCount: rows.length,
        superAdminCount: count((row) => row.isSuperAdmin),
        adminMembershipCount: count((row) => row.role === "admin"),
        schoolAdminMembershipCount: count((row) => row.role === "school_admin"),
        officeStaffMembershipCount: count((row) => row.role === "office_staff"),
      },
      privilegedUsers: rows,
    };
  } finally {
    await pool.end();
  }
}

export function formatPrivilegedPrivateEvidenceMarkdown(record) {
  const requiredFieldLines = record.requiredFields
    ? Object.entries(record.requiredFields).map(([key, value]) => `- ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`).join("\n")
    : "- No template fields.";
  const checklistLines = record.checklist
    ? record.checklist.map((item) => `- [ ] ${item}`).join("\n")
    : "- No checklist.";

  return `# ${record.title}

- Evidence ID: ${record.evidenceId}
- Approval ID: ${record.approvalId || "not_applicable"}
- Control ID: ${record.controlId}
- Remediation item: ${record.remediationItem}
- Evidence type: ${record.evidenceType}
- Status: ${record.status}
- Generated at: ${record.generatedAt}
- Expires at: ${record.expiresAt || "not_applicable"}
- App impact: ${record.appImpact}

## Completion Instructions

${(record.completionInstructions || []).map((item) => `- ${item}`).join("\n") || "- Not applicable."}

## Required Fields

${requiredFieldLines}

## Checklist

${checklistLines}

## Founder Completion

- Completed by: ${record.founderCompletion?.completedBy || "not_applicable"}
- Completed at: ${record.founderCompletion?.completedAt || "not_applicable"}
- Ready for approval: ${record.founderCompletion?.readyForApproval ?? "not_applicable"}

## Sensitive Data Handling

${record.sensitiveDataHandling || record.sensitiveDataBoundary || "Do not copy private contents into public artifacts."}
`;
}

function writeRecordPair({ privateEvidenceDir, relativeBasePath, record, force = false, replaceDraft = false }) {
  const jsonPath = path.join(privateEvidenceDir, `${relativeBasePath}.json`);
  const mdPath = path.join(privateEvidenceDir, `${relativeBasePath}.md`);
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });

  const existing = fs.existsSync(jsonPath) ? parseJsonFile(jsonPath, null) : null;
  if (existing && existing.status !== DRAFT_STATUS && !force) {
    throw new Error(`Refusing to overwrite non-draft privileged access evidence: ${jsonPath}`);
  }
  if (existing && existing.status === DRAFT_STATUS && !force && !replaceDraft) {
    return {
      evidenceType: existing.evidenceType || record.evidenceType,
      status: existing.status,
      jsonPath,
      markdownPath: mdPath,
      privateJsonPath: privateEvidenceRelativePath(privateEvidenceDir, jsonPath),
      privateMarkdownPath: privateEvidenceRelativePath(privateEvidenceDir, mdPath),
      skipped: true,
    };
  }

  fs.writeFileSync(jsonPath, `${JSON.stringify(record, null, 2)}\n`);
  fs.writeFileSync(mdPath, formatPrivilegedPrivateEvidenceMarkdown(record));

  return {
    evidenceType: record.evidenceType,
    status: record.status,
    jsonPath,
    markdownPath: mdPath,
    privateJsonPath: privateEvidenceRelativePath(privateEvidenceDir, jsonPath),
    privateMarkdownPath: privateEvidenceRelativePath(privateEvidenceDir, mdPath),
    skipped: false,
  };
}

export async function writePrivilegedAccessPrivateEvidenceKit({
  rootDir,
  privateEvidenceDir,
  now = new Date(),
  force = false,
  fromDatabase = false,
} = {}) {
  const resolvedRoot = rootDir || fileURLToPath(new URL("../..", import.meta.url));
  const resolvedPrivateDir = path.resolve(
    resolvedRoot,
    privateEvidenceDir || process.env.SOC2_PRIVATE_EVIDENCE_DIR || "../SchoolPilot-SOC2-Evidence",
  );
  assertPrivateEvidenceTarget(resolvedRoot, resolvedPrivateDir);

  const generatedAt = now.toISOString();
  const expiresAt = addDays(now, 90);
  const userRoleExport = fromDatabase
    ? await buildUserRoleExportFromDatabase({ generatedAt })
    : buildUserRoleExportTemplateRecord({ generatedAt });

  const outputs = [
    writeRecordPair({
      privateEvidenceDir: resolvedPrivateDir,
      relativeBasePath: path.join("access-reviews", "soc2-003-privileged-access-review"),
      record: buildAccessReviewRecord({ generatedAt }),
      force,
    }),
    writeRecordPair({
      privateEvidenceDir: resolvedPrivateDir,
      relativeBasePath: path.join("access-reviews", "exports", fromDatabase ? "soc2-003-user-role-export" : "soc2-003-user-role-export-template"),
      record: userRoleExport,
      force,
      replaceDraft: fromDatabase,
    }),
    writeRecordPair({
      privateEvidenceDir: resolvedPrivateDir,
      relativeBasePath: path.join("risk-acceptances", "soc2-003-mfa-deferral-risk-acceptance"),
      record: buildMfaDeferralRecord({ generatedAt, expiresAt }),
      force,
    }),
  ];

  return {
    evidenceId: "SOC2-003-PRIVILEGED-ACCESS-PRIVATE-EVIDENCE-KIT",
    generatedAt,
    status: DRAFT_STATUS,
    appImpact: APP_IMPACT,
    outputs,
  };
}

async function runCli() {
  const rootDir = path.resolve(argValue("root-dir", fileURLToPath(new URL("../..", import.meta.url))));
  const privateEvidenceDir = path.resolve(rootDir, argValue("private-dir", process.env.SOC2_PRIVATE_EVIDENCE_DIR || "../SchoolPilot-SOC2-Evidence"));
  const force = argEnabled("force");
  const fromDatabase = argEnabled("from-database");

  try {
    const result = await writePrivilegedAccessPrivateEvidenceKit({
      rootDir,
      privateEvidenceDir,
      force,
      fromDatabase,
    });

    for (const output of result.outputs) {
      const verb = output.skipped ? "kept existing draft" : "wrote";
      console.log(`[soc2-privileged-private-kit] ${verb} ${output.jsonPath}`);
      console.log(`[soc2-privileged-private-kit] ${verb} ${output.markdownPath}`);
    }
    console.log(`[soc2-privileged-private-kit] status: ${result.status}`);
  } catch (error) {
    console.error(`[soc2-privileged-private-kit] error: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
