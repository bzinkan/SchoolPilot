import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

// Imports the COMPILED output (CI builds first) so we exercise exactly what ships.
import { studentEmailDomainMatches } from "../dist/services/storage.js";
import { pool } from "../dist/db.js";

// storage.ts pulls in the pg Pool at import; these assertions never query it,
// but close the handle so the test process exits cleanly.
after(async () => { await pool.end(); });

describe("studentEmailDomainMatches (student email-domain guardrail)", () => {
  const SCHOOL = "desalescincy.org";

  it("allows a blank email — badge/ID-only students (GoPilot/PassPilot)", () => {
    assert.equal(studentEmailDomainMatches(null, SCHOOL).ok, true);
    assert.equal(studentEmailDomainMatches("", SCHOOL).ok, true);
    assert.equal(studentEmailDomainMatches(undefined, SCHOOL).ok, true);
  });

  it("allows any email when the school has no domain set (cannot validate)", () => {
    assert.equal(studentEmailDomainMatches("kid@gmail.com", null).ok, true);
  });

  it("accepts a matching domain, case/space-insensitive", () => {
    assert.equal(studentEmailDomainMatches("kid@desalescincy.org", SCHOOL).ok, true);
    assert.equal(studentEmailDomainMatches("Kid@DeSalesCincy.org", " desalescincy.org ").ok, true);
  });

  it("rejects a mismatched domain and reports both domains", () => {
    const r = studentEmailDomainMatches("kid@gmail.com", SCHOOL);
    assert.equal(r.ok, false);
    assert.equal(r.actualDomain, "gmail.com");
    assert.equal(r.expectedDomain, "desalescincy.org");
  });

  it("rejects a malformed email (no domain) when a school domain is set", () => {
    assert.equal(studentEmailDomainMatches("not-an-email", SCHOOL).ok, false);
  });
});
