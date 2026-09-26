import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RLS_GLOBAL_TABLES,
  RLS_HISTORICAL_OBSERVED_PRODUCTION_TABLES,
  RLS_POST_EXPAND_PRODUCTION_TABLES,
  RLS_REVIEWED_ENABLEMENT_REQUESTS,
  assertRlsRegistryIntegrity,
  isReviewedRlsEnforcementRequest,
} from "../src/db/rlsPolicies.js";

type RegistryInventory = {
  count: number;
  sha256: string;
  tables: string[];
  addedSinceHistoricalObservation?: string[];
};

type Registry = {
  globalTables: string[];
  inventories: {
    historicalObservedProduction: RegistryInventory;
    schoolPilot270PostExpand: RegistryInventory;
    classpilotRoadmapPostExpand: RegistryInventory;
    classpilotSupervisionWorkspacePostExpand: RegistryInventory;
    classpilotSupervisionActivityReportsPostExpand: RegistryInventory;
    classpilotClassToolsPostExpand: RegistryInventory;
    passpilotKioskSchedulePostExpand: RegistryInventory;
    mydeskPostExpand: RegistryInventory;
    mydeskSeatingPostExpand: RegistryInventory;
    mydeskImportsPostExpand: RegistryInventory;
  };
  reviewedEnablementRequests: Record<string, string[]>;
  semanticExceptions: {
    classpilotFabReadmission: {
      intentionallyExcludedTables: string[];
    };
  };
};

const registry = JSON.parse(
  readFileSync(new URL("../src/config/rlsRegistry.json", import.meta.url), "utf8"),
) as Registry;
const terraformVariables = readFileSync(
  new URL("../infra/variables.tf", import.meta.url),
  "utf8",
);
const productionTfvars = readFileSync(
  new URL("../infra/production.tfvars", import.meta.url),
  "utf8",
);
const terraformMain = readFileSync(new URL("../infra/main.tf", import.meta.url), "utf8");
const ciWorkflow = readFileSync(
  new URL("../.github/workflows/ci-build.yml", import.meta.url),
  "utf8",
);

function sha256(tables: readonly string[]): string {
  return createHash("sha256").update(tables.join(",")).digest("hex");
}

function terraformDefaultAllowlist(): string[] {
  const value = terraformVariables.match(
    /variable "rls_enabled_tables"[\s\S]*?default\s*=\s*"([^"]+)"/,
  )?.[1];
  assert.ok(value, "Terraform RLS default must be inspectable");
  return value.split(",");
}

function productionAllowlist(): string[] {
  const value = productionTfvars.match(/^rls_enabled_tables\s*=\s*"([^"]+)"/m)?.[1];
  assert.ok(value, "production.tfvars RLS allowlist must be inspectable");
  return value.split(",");
}

function ciAllowlist(): string[] {
  const value = ciWorkflow.match(/^\s+RLS_ENABLED_TABLES:\s*([^\r\n]+)$/m)?.[1];
  assert.ok(value, "CI RLS allowlist must be inspectable");
  return value.trim().split(",");
}

describe("semantic RLS registry", () => {
  it("preserves the exact historical observation independently of the expansion", () => {
    assert.doesNotThrow(assertRlsRegistryIntegrity);
    const historical = registry.inventories.historicalObservedProduction;
    const postExpand = registry.inventories.schoolPilot270PostExpand;

    assert.equal(historical.count, 72);
    assert.equal(historical.tables.length, 72);
    assert.equal(historical.sha256, "0e5f825a1baae25e0809d54e3ceae4600c25cde785202bfcb4c67664d2ed55f2");
    assert.equal(sha256(historical.tables), historical.sha256);
    assert.deepEqual(RLS_HISTORICAL_OBSERVED_PRODUCTION_TABLES, historical.tables);

    assert.equal(postExpand.count, 75);
    assert.equal(postExpand.tables.length, 75);
    assert.equal(sha256(postExpand.tables), postExpand.sha256);
    assert.deepEqual(RLS_POST_EXPAND_PRODUCTION_TABLES, postExpand.tables);
    assert.deepEqual(postExpand.addedSinceHistoricalObservation, [
      "classpilot_evidence_capture_requests",
      "passpilot_kiosk_devices",
      "passpilot_kiosk_sessions",
    ]);
  });

  it("keeps application globals and reviewed requests registry-backed", () => {
    assert.deepEqual([...RLS_GLOBAL_TABLES], registry.globalTables);
    assert.deepEqual(RLS_REVIEWED_ENABLEMENT_REQUESTS, registry.reviewedEnablementRequests);

    for (const request of Object.values(registry.reviewedEnablementRequests)) {
      assert.equal(isReviewedRlsEnforcementRequest(request), true);
    }
    assert.equal(isReviewedRlsEnforcementRequest(["classpilot_active_hands"]), false);
    assert.equal(
      isReviewedRlsEnforcementRequest(
        registry.reviewedEnablementRequests.classpilotFabReadmission!.slice(0, 3),
      ),
      false,
    );
  });

  it("adds forward My Desk reconciliation while retaining the three original admissions", () => {
    assert.deepEqual(registry.reviewedEnablementRequests.mydesk, ["mydesk_attachments", "mydesk_notes"]);
    assert.deepEqual(registry.reviewedEnablementRequests.mydeskSeating, ["mydesk_seating_charts"]);
    assert.deepEqual(registry.reviewedEnablementRequests.mydeskImports, ["mydesk_import_assets", "mydesk_import_items", "mydesk_imports"]);
    const combined = [
      ...registry.reviewedEnablementRequests.mydesk!,
      ...registry.reviewedEnablementRequests.mydeskSeating!,
      ...registry.reviewedEnablementRequests.mydeskImports!,
    ];
    assert.deepEqual(registry.reviewedEnablementRequests.mydeskReconciliation, combined);
    assert.equal(isReviewedRlsEnforcementRequest(combined), true);
    assert.equal(isReviewedRlsEnforcementRequest(combined.slice(0, 5)), false);
    assert.equal(isReviewedRlsEnforcementRequest([...combined].reverse()), false);
    assert.equal(registry.inventories.mydeskPostExpand.count, 105);
    assert.equal(registry.inventories.mydeskSeatingPostExpand.count, 106);
    assert.equal(registry.inventories.mydeskImportsPostExpand.count, 109);
  });

  it("preserves the intentional active-hands versus FAB bundle distinction", () => {
    const fullInventory = new Set(registry.inventories.schoolPilot270PostExpand.tables);
    const fabBundle = registry.reviewedEnablementRequests.classpilotFabReadmission!;
    const exceptions = registry.semanticExceptions.classpilotFabReadmission
      .intentionallyExcludedTables;

    assert.equal(fullInventory.has("classpilot_active_hands"), true);
    assert.equal(fabBundle.includes("classpilot_active_hands"), false);
    assert.deepEqual(exceptions, ["classpilot_active_hands"]);
    assert.deepEqual(fabBundle, [
      "classpilot_chat_deliveries",
      "poll_responses",
      "polls",
      "session_settings",
    ]);
  });

  it("adopts the verified production inventory without changing the generic rollout baseline", () => {
    const expected = registry.inventories.classpilotRoadmapPostExpand.tables;
    assert.deepEqual(terraformDefaultAllowlist(), registry.inventories.schoolPilot270PostExpand.tables);
    const production = productionAllowlist();
    assert.equal(production.length, 90);
    assert.equal(new Set(production).size, 90);
    // Preserve observed runtime CSV order; the registry target has its own immutable order.
    assert.deepEqual(new Set(production), new Set(expected));
    assert.deepEqual(ciAllowlist(), registry.inventories.mydeskImportsPostExpand.tables);
    assert.deepEqual(registry.inventories.mydeskImportsPostExpand.tables, [
      ...registry.inventories.mydeskSeatingPostExpand.tables,
      ...registry.reviewedEnablementRequests.mydeskImports!,
    ]);
    assert.deepEqual(registry.inventories.mydeskSeatingPostExpand.tables, [
      ...registry.inventories.mydeskPostExpand.tables,
      ...registry.reviewedEnablementRequests.mydeskSeating!,
    ]);
    assert.deepEqual(registry.inventories.mydeskPostExpand.tables, [
      ...registry.inventories.passpilotKioskSchedulePostExpand.tables,
      ...registry.reviewedEnablementRequests.mydesk!,
    ]);
    assert.deepEqual(registry.inventories.classpilotSupervisionWorkspacePostExpand.tables, [...expected, "classpilot_coverage_group_categories"]);
    assert.deepEqual(registry.inventories.classpilotSupervisionActivityReportsPostExpand.tables, [
      ...registry.inventories.classpilotSupervisionWorkspacePostExpand.tables,
      "classpilot_supervision_report_segments", "classpilot_supervision_student_reports", "classpilot_supervision_summary_deliveries",
    ]);
    assert.deepEqual(registry.inventories.classpilotClassToolsPostExpand.tables, [
      ...registry.inventories.classpilotSupervisionActivityReportsPostExpand.tables,
      ...registry.reviewedEnablementRequests.classpilotClassTools!,
    ]);
    assert.match(terraformMain, /src\/config\/rlsRegistry\.json/);
    assert.match(terraformMain, /check "rls_registry_contract"/);
    assert.match(terraformMain, /setsubtract/);
  });
});
