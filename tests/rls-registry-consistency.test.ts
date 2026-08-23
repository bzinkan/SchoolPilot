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

  it("keeps Terraform, production, and CI on the exact post-expand sequence", () => {
    const expected = registry.inventories.schoolPilot270PostExpand.tables;
    assert.deepEqual(terraformDefaultAllowlist(), expected);
    assert.deepEqual(productionAllowlist(), expected);
    assert.deepEqual(ciAllowlist(), expected);
    assert.match(terraformMain, /src\/config\/rlsRegistry\.json/);
    assert.match(terraformMain, /check "rls_registry_contract"/);
    assert.match(terraformMain, /setsubtract/);
  });
});
