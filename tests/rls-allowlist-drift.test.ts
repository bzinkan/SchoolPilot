import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findMissingRlsAllowlistEntries,
  findUnknownRlsAllowlistEntries,
} from "../src/db/rlsPolicies.js";

describe("RLS allowlist drift guard", () => {
  it("reports discovered tenant tables that are absent from RLS_ENABLED_TABLES", () => {
    const tenantTables = ["students", "groups", "chat_messages"];
    const allowlist = new Set(["students", "groups"]);

    assert.deepEqual(findMissingRlsAllowlistEntries(allowlist, tenantTables), ["chat_messages"]);
  });

  it("reports stale RLS_ENABLED_TABLES entries that are not tenant tables", () => {
    const tenantTables = ["students", "groups"];
    const allowlist = new Set(["students", "groups", "stale_table"]);

    assert.deepEqual(findUnknownRlsAllowlistEntries(allowlist, tenantTables), ["stale_table"]);
  });
});
