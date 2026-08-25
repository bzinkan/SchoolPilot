#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const testsRoot = join(root, "tests");

const RLS_SERIAL = new Set([
  "classpilot-fab-parent-rls.integration.test.ts",
  "classpilot-schedule-change-rls.test.ts",
  "classpilot-tile-authorization-plan-self-provisioning.integration.test.ts",
  "cross-tenant-isolation.test.ts",
  "gopilot-rls-isolation.test.ts",
  "passpilot-canonical-runtime.test.ts",
  "passpilot-legacy-multiclass.test.ts",
  "passpilot-kiosk-sessions.test.ts",
  "passpilot-report-issuers.test.ts",
  "rls-tenant-context.test.ts",
]);

const DB_SERIAL = new Set([
  "authenticate-operational-failure.test.ts",
  "auth-membership-lifecycle.test.ts",
  "classpilot-2-7-1-command-frame.test.ts",
  "classpilot-admin-analytics.test.ts",
  "classpilot-admin-classes.test.ts",
  "classpilot-ai-decision-route-privacy.test.ts",
  "classpilot-coverage-hydration.test.ts",
  "classpilot-coverage.test.ts",
  "classpilot-entitlement.test.ts",
  "classpilot-evidence-expiry-digest.test.ts",
  "classpilot-flight-path-import-contract.test.ts",
  "classpilot-heartbeat-presence.test.ts",
  "classpilot-instructional-calendar.test.ts",
  "classpilot-monitoring-reports.test.ts",
  "classpilot-runtime-security-contract.test.ts",
  "classpilot-schedule-changes.test.ts",
  "classpilot-school-status-auth.test.ts",
  "classpilot-session-report-rollout.test.ts",
  "classpilot-session-summary-lifecycle.test.ts",
  "classpilot-student-auth.test.ts",
  "classpilot-student-data-contract.test.ts",
  "classpilot-tile-history-lateral.test.ts",
  "classpilot-tile-read-scope.test.ts",
  "classpilot-web-session-routing.test.ts",
  "classpilot-websocket-passive-authorization.test.ts",
  "error-monitor.test.ts",
  "gopilot-entitlement.test.ts",
  "gopilot-parent-containment.test.ts",
  "gopilot-runtime-contracts.test.ts",
  "gopilot-settings.test.ts",
  "gopilot-setup-deletion.test.ts",
  "gopilot-socket-containment.test.ts",
  "gopilot-two-instance-realtime.test.ts",
  "google-staff-import-error-sanitization.test.ts",
  "heartbeat-tracking-settings-cache.test.ts",
  "multi-role-authorization.test.ts",
  "multi-school-readiness-routes.test.ts",
  "p0-traffic-schema.test.ts",
  "passpilot-clean-cutover-runtime.test.ts",
  "passpilot-overdue-lifecycle.test.ts",
  "passpilot-settings.test.ts",
  // This hermetic policy probe creates a role and table, then validates FORCE
  // RLS through SET ROLE. It requires the ordinary admin DB posture and must
  // not be repeated through the restricted RLS connection.
  "rls-policy.test.ts",
  "scheduler-lock.test.ts",
  "school-lifecycle-inquiries.test.ts",
  "student-email-domain.test.ts",
  "student-email-policy.test.ts",
  "student-removal-lifecycle.test.ts",
  "staff-assignment-lifecycle.test.ts",
  "staff-assignment-integrity-readiness.test.ts",
  "staff-credential-realtime-contract.test.ts",
  "staff-identity-integrity.integration.test.ts",
  "staff-identity-lifecycle.test.ts",
  "staff-identity-monitoring.test.ts",
]);

const INFRASTRUCTURE = /^(?:aws-|capacity-|credential-rotation-infra|database-insights|deploy-|ecs-|frontend-dependency|classpilot-(?:arrival-capacity|load-|tile-auth-plan-|tile-authorization-plan-check)|gopilot-containment-inventory|heartbeat-history-index-contract|hot-path-logging|migration-ledger|predeploy-safety|private-load|production-terraform|redis-ready|rls-allowlist-drift|soc2-|terraform-|runtime-config)/;

function discover(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return discover(path);
    return /\.test\.(?:ts|mjs)$/.test(entry.name) ? [path] : [];
  });
}

const all = discover(testsRoot).sort();
const primaryLane = (path) => {
  const name = basename(path);
  if (RLS_SERIAL.has(name)) return "rls";
  if (DB_SERIAL.has(name)) return "db";
  if (INFRASTRUCTURE.test(name)) return "infrastructure";
  return "unit";
};

const requested = process.argv[2];
if (!["unit", "db", "rls", "infrastructure", "list"].includes(requested)) {
  process.stderr.write("Usage: node scripts/run-test-lane.mjs unit|db|rls|infrastructure|list\n");
  process.exit(2);
}

if (requested === "list") {
  for (const path of all) {
    process.stdout.write(`${primaryLane(path)}\t${relative(root, path).replaceAll("\\", "/")}\n`);
  }
  process.exit(0);
}

// RLS tests deliberately run once in the ordinary DB posture and again with
// FORCE RLS. This is the one intentional overlap between otherwise exclusive
// primary lanes.
const selected = all.filter((path) => {
  const lane = primaryLane(path);
  if (requested === "db") return lane === "db" || lane === "rls";
  return lane === requested;
});
if (selected.length === 0) {
  process.stderr.write(`No tests classified for ${requested}\n`);
  process.exit(2);
}

const concurrency = requested === "unit" ? "4" : "1";
const result = spawnSync(process.execPath, [
  "--env-file-if-exists=.env",
  "--import", "./tests/test-environment.mjs",
  "--import", "tsx",
  "--test",
  `--test-concurrency=${concurrency}`,
  ...selected.map((path) => relative(root, path)),
], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
